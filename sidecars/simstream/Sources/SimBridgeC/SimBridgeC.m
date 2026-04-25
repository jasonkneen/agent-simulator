#import "SimBridgeC.h"

#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <dlfcn.h>
#import <dispatch/dispatch.h>

static NSObject *gLock;
static id gDevice;
static id gDisplayDescriptor;
static id gDisplayPort;
static id gIOClient;
static NSUUID *gCallbackUUID;
static void (^gSurfaceCallback)(id);
static IOSurfaceRef gSurface;

static SEL sel(const char *name) { return sel_registerName(name); }
static id call_id(id obj, SEL selector) { return ((id (*)(id, SEL))objc_msgSend)(obj, selector); }
static id call_id_error(id obj, SEL selector, NSError **error) { return ((id (*)(id, SEL, NSError **))objc_msgSend)(obj, selector, error); }
static NSInteger call_integer(id obj, SEL selector) { return ((NSInteger (*)(id, SEL))objc_msgSend)(obj, selector); }

static void set_error(char **errorOut, NSString *message) {
  if (!errorOut) return;
  *errorOut = strdup(message.UTF8String ?: "unknown simstream bridge error");
}

void SPBridgeFreeCString(char *s) {
  if (s) free(s);
}

static NSString *developer_dir(void) {
  NSString *env = NSProcessInfo.processInfo.environment[@"DEVELOPER_DIR"];
  if (env.length > 0) return env;
  NSPipe *pipe = [NSPipe pipe];
  NSTask *task = [[NSTask alloc] init];
  task.launchPath = @"/usr/bin/xcode-select";
  task.arguments = @[@"-p"];
  task.standardOutput = pipe;
  task.standardError = [NSPipe pipe];
  @try {
    [task launch];
    [task waitUntilExit];
  } @catch (__unused NSException *e) {
    return @"/Applications/Xcode.app/Contents/Developer";
  }
  NSData *data = [[pipe fileHandleForReading] readDataToEndOfFile];
  NSString *out = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  out = [out stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  return out.length > 0 ? out : @"/Applications/Xcode.app/Contents/Developer";
}

static bool load_private_frameworks(char **errorOut) {
  NSString *corePath = @"/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator";
  if (!dlopen(corePath.UTF8String, RTLD_NOW | RTLD_GLOBAL)) {
    set_error(errorOut, [NSString stringWithFormat:@"failed to load CoreSimulator: %s", dlerror() ?: "unknown"]);
    return false;
  }

  NSString *simKitPath = [developer_dir() stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"];
  if (!dlopen(simKitPath.UTF8String, RTLD_NOW | RTLD_GLOBAL)) {
    set_error(errorOut, [NSString stringWithFormat:@"failed to load SimulatorKit at %@: %s", simKitPath, dlerror() ?: "unknown"]);
    return false;
  }
  return true;
}

static NSString *uuid_string_for_device(id device) {
  if (!device || ![device respondsToSelector:@selector(UDID)]) return nil;
  id udid = call_id(device, @selector(UDID));
  if ([udid respondsToSelector:@selector(UUIDString)]) return ((NSString *(*)(id, SEL))objc_msgSend)(udid, @selector(UUIDString));
  return [udid description];
}

static id find_device(NSString *wantedUDID, char **errorOut) {
  Class ctxClass = NSClassFromString(@"SimServiceContext");
  if (!ctxClass) {
    set_error(errorOut, @"SimServiceContext class not found after loading CoreSimulator");
    return nil;
  }

  NSError *error = nil;
  id ctx = nil;
  SEL sharedForDev = NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:");
  if ([ctxClass respondsToSelector:sharedForDev]) {
    ctx = ((id (*)(Class, SEL, id, NSError **))objc_msgSend)(ctxClass, sharedForDev, developer_dir(), &error);
  }
  if (!ctx && [ctxClass respondsToSelector:NSSelectorFromString(@"sharedServiceContext")]) {
    ctx = ((id (*)(Class, SEL))objc_msgSend)(ctxClass, NSSelectorFromString(@"sharedServiceContext"));
  }
  if (!ctx) {
    set_error(errorOut, [NSString stringWithFormat:@"unable to create SimServiceContext: %@", error.localizedDescription ?: @"unknown error"]);
    return nil;
  }

  id deviceSet = nil;
  if ([ctx respondsToSelector:NSSelectorFromString(@"defaultDeviceSetWithError:")]) {
    error = nil;
    deviceSet = call_id_error(ctx, NSSelectorFromString(@"defaultDeviceSetWithError:"), &error);
  }
  if (!deviceSet && [ctx respondsToSelector:NSSelectorFromString(@"defaultDeviceSet")]) {
    deviceSet = call_id(ctx, NSSelectorFromString(@"defaultDeviceSet"));
  }
  if (!deviceSet) {
    set_error(errorOut, [NSString stringWithFormat:@"unable to resolve default simulator device set: %@", error.localizedDescription ?: @"unknown error"]);
    return nil;
  }

  NSArray *devices = nil;
  if ([deviceSet respondsToSelector:@selector(devices)]) devices = call_id(deviceSet, @selector(devices));
  for (id device in devices) {
    NSString *deviceUDID = uuid_string_for_device(device);
    if (wantedUDID.length > 0 && [deviceUDID isEqualToString:wantedUDID]) return device;
  }

  set_error(errorOut, [NSString stringWithFormat:@"booted simulator %@ was not found in CoreSimulator", wantedUDID ?: @"(nil)"]);
  return nil;
}

static NSArray *ports_for_io(id ioClient) {
  if (!ioClient) return nil;
  @try {
    if ([ioClient respondsToSelector:NSSelectorFromString(@"updateIOPorts")]) {
      ((void (*)(id, SEL))objc_msgSend)(ioClient, NSSelectorFromString(@"updateIOPorts"));
    }
  } @catch (__unused NSException *e) {}

  const char *selectors[] = {"deviceIOPorts", "ioPorts", "ioPortsCopy", "allPorts", "ports"};
  for (size_t i = 0; i < sizeof(selectors) / sizeof(selectors[0]); i++) {
    SEL selector = NSSelectorFromString([NSString stringWithUTF8String:selectors[i]]);
    if (![ioClient respondsToSelector:selector]) continue;
    @try {
      id value = call_id(ioClient, selector);
      if ([value isKindOfClass:NSArray.class]) return value;
    } @catch (__unused NSException *e) {}
  }
  return nil;
}

static IOSurfaceRef copy_framebuffer_surface(id descriptor) {
  if (!descriptor) return nil;
  SEL framebuffer = NSSelectorFromString(@"framebufferSurface");
  if (![descriptor respondsToSelector:framebuffer]) return nil;
  @try {
    id surfaceObject = call_id(descriptor, framebuffer);
    if (!surfaceObject) return nil;
    IOSurfaceRef surface = (__bridge IOSurfaceRef)surfaceObject;
    if (surface) CFRetain(surface);
    return surface;
  } @catch (NSException *e) {
    fprintf(stderr, "[simstream] framebufferSurface threw: %s\n", e.description.UTF8String);
    return nil;
  }
}

static void update_surface(IOSurfaceRef surface) {
  if (!surface) return;
  CFRetain(surface);
  IOSurfaceRef old = nil;
  @synchronized (gLock) {
    old = gSurface;
    gSurface = surface;
  }
  if (old) CFRelease(old);
}

static void refresh_surface_from_display(void) {
  IOSurfaceRef surface = copy_framebuffer_surface(gDisplayDescriptor);
  if (surface) {
    update_surface(surface);
    CFRelease(surface);
  }
}

static id display_descriptor_from_candidate(id candidate, Protocol *displayProtocol) {
  if (!candidate || !displayProtocol) return nil;
  if ([candidate conformsToProtocol:displayProtocol]) return candidate;
  @try {
    if ([candidate respondsToSelector:@selector(descriptor)]) {
      id descriptor = call_id(candidate, @selector(descriptor));
      if ([descriptor conformsToProtocol:displayProtocol]) return descriptor;
    }
  } @catch (__unused NSException *e) {}
  return nil;
}

static bool find_display_endpoint(id device, id *outIO, id *outPort, id *outDescriptor, char **errorOut) {
  Protocol *displayProtocol = objc_getProtocol("SimDisplayIOSurfaceRenderable");
  if (!displayProtocol) {
    set_error(errorOut, @"SimDisplayIOSurfaceRenderable protocol not found after loading SimulatorKit");
    return false;
  }

  id ioClient = nil;
  for (NSString *name in @[@"io", @"deviceIO", @"ioClient"]) {
    SEL selector = NSSelectorFromString(name);
    if ([device respondsToSelector:selector]) {
      @try { ioClient = call_id(device, selector); } @catch (__unused NSException *e) {}
      if (ioClient) break;
    }
  }

  id bestPort = nil;
  id bestDescriptor = nil;
  size_t bestPixels = 0;

  NSArray *ports = ports_for_io(ioClient);
  for (id port in ports) {
    id descriptor = display_descriptor_from_candidate(port, displayProtocol);
    if (!descriptor) continue;
    IOSurfaceRef surface = copy_framebuffer_surface(descriptor);
    size_t pixels = surface ? IOSurfaceGetWidth(surface) * IOSurfaceGetHeight(surface) : 0;
    if (surface) CFRelease(surface);
    if (!bestDescriptor || pixels > bestPixels) {
      bestPort = port;
      bestDescriptor = descriptor;
      bestPixels = pixels;
    }
  }

  if (!bestDescriptor) {
    for (NSString *name in @[@"mainDisplay", @"mainScreen", @"defaultDisplay", @"display", @"screen"]) {
      SEL selector = NSSelectorFromString(name);
      if (![device respondsToSelector:selector]) continue;
      @try {
        id candidate = call_id(device, selector);
        id descriptor = display_descriptor_from_candidate(candidate, displayProtocol);
        if (descriptor) {
          bestDescriptor = descriptor;
          break;
        }
      } @catch (__unused NSException *e) {}
    }
  }

  if (!bestDescriptor) {
    set_error(errorOut, ioClient
      ? @"no SimDisplayIOSurfaceRenderable descriptor found in simulator io ports"
      : @"simulator device has no accessible display io client or display descriptor");
    return false;
  }

  if (outIO) *outIO = ioClient;
  if (outPort) *outPort = bestPort;
  if (outDescriptor) *outDescriptor = bestDescriptor;
  return true;
}

static void try_attach_consumer(id ioClient, id port) {
  SEL attach = NSSelectorFromString(@"attachConsumer:withUUID:toPort:errorQueue:errorHandler:");
  if (!ioClient || !port || ![ioClient respondsToSelector:attach]) return;
  NSUUID *uuid = [NSUUID UUID];
  id consumer = @"sim-preview.simstream.display";
  void (^handler)(NSError *) = ^(NSError *error) {
    if (error) fprintf(stderr, "[simstream] attachConsumer error: %s\n", error.description.UTF8String);
  };
  @try {
    ((void (*)(id, SEL, id, id, id, id, id))objc_msgSend)(ioClient, attach, consumer, uuid, port, dispatch_get_main_queue(), handler);
    fprintf(stderr, "[simstream] attached display consumer (uuid=%s)\n", uuid.UUIDString.UTF8String);
  } @catch (NSException *e) {
    fprintf(stderr, "[simstream] attachConsumer threw: %s\n", e.description.UTF8String);
  }
}

bool SPBridgeStart(const char *udid, char **errorOut) {
  @autoreleasepool {
    if (errorOut) *errorOut = nil;
    if (!gLock) gLock = [NSObject new];
    SPBridgeStop();

    if (!load_private_frameworks(errorOut)) return false;

    NSString *wanted = udid ? [NSString stringWithUTF8String:udid] : nil;
    id device = find_device(wanted, errorOut);
    if (!device) return false;

    id ioClient = nil;
    id displayPort = nil;
    id descriptor = nil;
    if (!find_display_endpoint(device, &ioClient, &displayPort, &descriptor, errorOut)) return false;

    gDevice = device;
    gIOClient = ioClient;
    gDisplayPort = displayPort;
    gDisplayDescriptor = descriptor;

    refresh_surface_from_display();
    IOSurfaceRef initialSurface = SPBridgeCopySurface();
    if (!initialSurface) {
      set_error(errorOut, @"display descriptor did not expose a framebuffer IOSurface");
      return false;
    }
    CFRelease(initialSurface);

    gCallbackUUID = [NSUUID UUID];
    gSurfaceCallback = ^(__unused id arg) {
      refresh_surface_from_display();
    };

    BOOL subscribed = NO;
    const char *registrationSelectors[] = {
      "registerCallbackWithUUID:ioSurfacesChangeCallback:",
      "registerCallbackWithUUID:ioSurfaceChangeCallback:",
      "registerCallbackWithUUID:callback:",
    };
    for (size_t i = 0; i < sizeof(registrationSelectors) / sizeof(registrationSelectors[0]); i++) {
      SEL selector = NSSelectorFromString([NSString stringWithUTF8String:registrationSelectors[i]]);
      if (![gDisplayDescriptor respondsToSelector:selector]) continue;
      @try {
        ((void (*)(id, SEL, id, id))objc_msgSend)(gDisplayDescriptor, selector, gCallbackUUID, gSurfaceCallback);
        fprintf(stderr, "[simstream] subscribed via %s (uuid=%s)\n", registrationSelectors[i], gCallbackUUID.UUIDString.UTF8String);
        subscribed = YES;
        break;
      } @catch (NSException *e) {
        fprintf(stderr, "[simstream] callback registration %s threw: %s\n", registrationSelectors[i], e.description.UTF8String);
      }
    }
    if (!subscribed) {
      fprintf(stderr, "[simstream] display descriptor has no known IOSurface callback registration selector; polling framebufferSurface only\n");
    }

    try_attach_consumer(gIOClient, gDisplayPort);
    return true;
  }
}

IOSurfaceRef SPBridgeCopySurface(void) {
  if (!gLock) return nil;
  @synchronized (gLock) {
    if (!gSurface) return nil;
    CFRetain(gSurface);
    return gSurface;
  }
}

void SPBridgeStop(void) {
  @autoreleasepool {
    if (gDisplayDescriptor && gCallbackUUID) {
      const char *unregisterSelectors[] = {
        "unregisterIOSurfacesChangeCallbackWithUUID:",
        "unregisterIOSurfaceChangeCallbackWithUUID:",
        "unregisterCallbackWithUUID:",
      };
      for (size_t i = 0; i < sizeof(unregisterSelectors) / sizeof(unregisterSelectors[0]); i++) {
        SEL selector = NSSelectorFromString([NSString stringWithUTF8String:unregisterSelectors[i]]);
        if (![gDisplayDescriptor respondsToSelector:selector]) continue;
        @try { ((void (*)(id, SEL, id))objc_msgSend)(gDisplayDescriptor, selector, gCallbackUUID); }
        @catch (__unused NSException *e) {}
      }
    }
    gSurfaceCallback = nil;
    gCallbackUUID = nil;
    gDisplayDescriptor = nil;
    gDisplayPort = nil;
    gIOClient = nil;
    gDevice = nil;
    IOSurfaceRef old = nil;
    @synchronized (gLock) {
      old = gSurface;
      gSurface = nil;
    }
    if (old) CFRelease(old);
  }
}
