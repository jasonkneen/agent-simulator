use std::sync::Arc;
use std::time::{Duration, Instant};
use core_graphics::geometry::CGRect;
use log::{info, warn, debug};
use tokio::sync::{broadcast, watch};

// Raw FFI for CoreGraphics window capture
#[allow(non_upper_case_globals)]
const kCGWindowListOptionOnScreenOnly: u32 = 1 << 0;
#[allow(non_upper_case_globals)]
const kCGWindowListExcludeDesktopElements: u32 = 1 << 4;
#[allow(non_upper_case_globals)]
const kCGWindowListOptionIncludingWindow: u32 = 1 << 3;
#[allow(non_upper_case_globals)]
const kCGNullWindowID: u32 = 0;

type CFArrayRef = *const std::ffi::c_void;
type CFDictionaryRef = *const std::ffi::c_void;
type CFStringRef = *const std::ffi::c_void;
type CFNumberRef = *const std::ffi::c_void;
type CGImageRef = *const std::ffi::c_void;
type CFDataRef = *const std::ffi::c_void;
type CGDataProviderRef = *const std::ffi::c_void;
type CFTypeRef = *const std::ffi::c_void;

extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relativeToWindow: u32) -> CFArrayRef;
    fn CGWindowListCreateImage(
        screenBounds: CGRect,
        listOption: u32,
        windowID: u32,
        imageOption: u32,
    ) -> CGImageRef;
    fn CFArrayGetCount(theArray: CFArrayRef) -> isize;
    fn CFArrayGetValueAtIndex(theArray: CFArrayRef, idx: isize) -> CFDictionaryRef;
    fn CFDictionaryGetValue(theDict: CFDictionaryRef, key: CFStringRef) -> CFTypeRef;
    fn CFStringGetCStringPtr(theString: CFStringRef, encoding: u32) -> *const i8;
    fn CFStringCreateWithCString(
        alloc: CFTypeRef,
        cstr: *const i8,
        encoding: u32,
    ) -> CFStringRef;
    fn CFNumberGetValue(number: CFNumberRef, theType: u32, valuePtr: *mut std::ffi::c_void) -> bool;
    fn CGImageGetWidth(image: CGImageRef) -> usize;
    fn CGImageGetHeight(image: CGImageRef) -> usize;
    fn CGImageGetBytesPerRow(image: CGImageRef) -> usize;
    fn CGImageGetBitsPerPixel(image: CGImageRef) -> usize;
    fn CGImageGetDataProvider(image: CGImageRef) -> CGDataProviderRef;
    fn CGDataProviderCopyData(provider: CGDataProviderRef) -> CFDataRef;
    fn CFDataGetLength(theData: CFDataRef) -> isize;
    fn CFDataGetBytePtr(theData: CFDataRef) -> *const u8;
    fn CFRelease(cf: CFTypeRef);
    fn CGRectMakeWithDictionaryRepresentation(
        dict: CFDictionaryRef,
        rect: *mut CGRect,
    ) -> bool;
}

#[allow(non_upper_case_globals)]
const kCFStringEncodingUTF8: u32 = 0x08000100;
// CFNumber types
#[allow(non_upper_case_globals)]
const kCFNumberSInt32Type: u32 = 3;
#[allow(non_upper_case_globals)]
const kCFNumberSInt64Type: u32 = 4;
#[allow(non_upper_case_globals, dead_code)]
const kCFNumberFloat64Type: u32 = 13;

unsafe fn cf_string_create(s: &str) -> CFStringRef {
    let cstr = std::ffi::CString::new(s).unwrap();
    CFStringCreateWithCString(std::ptr::null(), cstr.as_ptr(), kCFStringEncodingUTF8)
}

extern "C" {
    fn CFStringGetLength(theString: CFStringRef) -> isize;
    fn CFStringGetCString(
        theString: CFStringRef,
        buffer: *mut i8,
        bufferSize: isize,
        encoding: u32,
    ) -> bool;
}

unsafe fn cf_string_to_rust(s: CFStringRef) -> Option<String> {
    if s.is_null() {
        return None;
    }
    // Try fast path first
    let ptr = CFStringGetCStringPtr(s, kCFStringEncodingUTF8);
    if !ptr.is_null() {
        return Some(std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned());
    }
    // Fallback: use CFStringGetCString
    let len = CFStringGetLength(s);
    // UTF-8 can be up to 4 bytes per character
    let buf_size = (len * 4 + 1) as usize;
    let mut buf = vec![0i8; buf_size];
    if CFStringGetCString(s, buf.as_mut_ptr(), buf_size as isize, kCFStringEncodingUTF8) {
        Some(std::ffi::CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
    } else {
        None
    }
}

unsafe fn cf_number_to_i32(n: CFNumberRef) -> Option<i32> {
    if n.is_null() {
        return None;
    }
    let mut value: i32 = 0;
    if CFNumberGetValue(n, kCFNumberSInt32Type, &mut value as *mut i32 as *mut _) {
        Some(value)
    } else {
        // Try i64
        let mut value64: i64 = 0;
        if CFNumberGetValue(n, kCFNumberSInt64Type, &mut value64 as *mut i64 as *mut _) {
            Some(value64 as i32)
        } else {
            None
        }
    }
}

#[allow(dead_code)]
unsafe fn cf_number_to_f64(n: CFNumberRef) -> Option<f64> {
    if n.is_null() {
        return None;
    }
    let mut value: f64 = 0.0;
    if CFNumberGetValue(n, kCFNumberFloat64Type, &mut value as *mut f64 as *mut _) {
        Some(value)
    } else {
        None
    }
}

/// Find the simulator window ID.
/// Returns (window_id, window_bounds) if found.
pub fn find_simulator_window(_udid: &str) -> Option<(u32, CGRect)> {
    unsafe {
        let window_list = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        );

        if window_list.is_null() {
            return None;
        }

        let count = CFArrayGetCount(window_list);

        let key_owner = cf_string_create("kCGWindowOwnerName");
        let key_name = cf_string_create("kCGWindowName");
        let key_number = cf_string_create("kCGWindowNumber");
        let key_layer = cf_string_create("kCGWindowLayer");
        let key_bounds = cf_string_create("kCGWindowBounds");

        let mut result = None;

        for i in 0..count {
            let dict = CFArrayGetValueAtIndex(window_list, i);
            if dict.is_null() {
                continue;
            }

            // Get owner name
            let owner_val = CFDictionaryGetValue(dict, key_owner);
            let owner_name = cf_string_to_rust(owner_val);

            match owner_name.as_deref() {
                Some("Simulator") => {}
                _ => continue,
            }

            // Get window name
            let name_val = CFDictionaryGetValue(dict, key_name);
            let window_name = cf_string_to_rust(name_val);

            // Get layer
            let layer_val = CFDictionaryGetValue(dict, key_layer);
            let layer = cf_number_to_i32(layer_val).unwrap_or(-1);

            // Only consider layer 0 (main content windows)
            if layer != 0 {
                continue;
            }

            // Get window ID
            let id_val = CFDictionaryGetValue(dict, key_number);
            let window_id = match cf_number_to_i32(id_val) {
                Some(id) => id,
                None => continue,
            };

            // Get bounds
            let bounds_val = CFDictionaryGetValue(dict, key_bounds);
            if bounds_val.is_null() {
                continue;
            }

            let mut rect = CGRect::new(
                &core_graphics::geometry::CGPoint::new(0.0, 0.0),
                &core_graphics::geometry::CGSize::new(0.0, 0.0),
            );

            if !CGRectMakeWithDictionaryRepresentation(bounds_val, &mut rect) {
                continue;
            }

            let w = rect.size.width;
            let h = rect.size.height;

            if w > 100.0 && h > 100.0 {
                info!(
                    "Found Simulator window: id={}, name={:?}, bounds=({:.0},{:.0},{:.0},{:.0})",
                    window_id,
                    window_name,
                    rect.origin.x,
                    rect.origin.y,
                    w,
                    h
                );
                result = Some((window_id as u32, rect));
                break;
            }
        }

        CFRelease(key_owner);
        CFRelease(key_name);
        CFRelease(key_number);
        CFRelease(key_layer);
        CFRelease(key_bounds);
        CFRelease(window_list);

        result
    }
}

/// Capture a single frame from the simulator window using CGWindowListCreateImage.
fn capture_window_frame_quality(window_id: u32, quality: u8) -> Option<Vec<u8>> {
    unsafe {
        // CGRectNull tells CGWindowListCreateImage to use the window's bounds
        let null_rect = CGRect::new(
            &core_graphics::geometry::CGPoint::new(f64::INFINITY, f64::INFINITY),
            &core_graphics::geometry::CGSize::new(0.0, 0.0),
        );

        let image_ref = CGWindowListCreateImage(
            null_rect,
            kCGWindowListOptionIncludingWindow,
            window_id,
            0, // kCGWindowImageDefault
        );

        if image_ref.is_null() {
            warn!("CGWindowListCreateImage returned null for window {}", window_id);
            return None;
        }

        let width = CGImageGetWidth(image_ref);
        let height = CGImageGetHeight(image_ref);
        let bytes_per_row = CGImageGetBytesPerRow(image_ref);
        let bits_per_pixel = CGImageGetBitsPerPixel(image_ref);
        let bytes_per_pixel = bits_per_pixel / 8;

        if width == 0 || height == 0 {
            warn!("CGImage has zero dimensions: {}x{}", width, height);
            CFRelease(image_ref);
            return None;
        }
        
        debug!("Frame: {}x{}, bpr={}, bpp={}", width, height, bytes_per_row, bits_per_pixel);

        // Get pixel data
        let provider = CGImageGetDataProvider(image_ref);
        if provider.is_null() {
            CFRelease(image_ref);
            return None;
        }

        let data_ref = CGDataProviderCopyData(provider);
        if data_ref.is_null() {
            CFRelease(image_ref);
            return None;
        }

        let data_len = CFDataGetLength(data_ref) as usize;
        let data_ptr = CFDataGetBytePtr(data_ref);
        let raw_bytes = std::slice::from_raw_parts(data_ptr, data_len);

        // Convert BGRA to RGB
        let mut rgb_data = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            for x in 0..width {
                let offset = y * bytes_per_row + x * bytes_per_pixel;
                if offset + 2 < raw_bytes.len() {
                    let b = raw_bytes[offset];
                    let g = raw_bytes[offset + 1];
                    let r = raw_bytes[offset + 2];
                    rgb_data.push(r);
                    rgb_data.push(g);
                    rgb_data.push(b);
                }
            }
        }

        CFRelease(data_ref);
        CFRelease(image_ref);

        // Encode to JPEG
        let mut jpeg_buf = Vec::new();
        let encoder = jpeg_encoder::Encoder::new(&mut jpeg_buf, quality);
        match encoder.encode(
            &rgb_data,
            width as u16,
            height as u16,
            jpeg_encoder::ColorType::Rgb,
        ) {
            Ok(()) => Some(jpeg_buf),
            Err(e) => {
                warn!("JPEG encode error: {}", e);
                None
            }
        }
    }
}

/// Fallback capture using xcrun simctl io screenshot to a temp file
async fn capture_via_simctl(udid: &str) -> Option<Vec<u8>> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = format!("/tmp/sim-capture-{}.png", count % 4); // rotate 4 temp files
    
    let output = tokio::process::Command::new("xcrun")
        .args(["simctl", "io", udid, "screenshot", "--type=png", &tmp_path])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let png_data = tokio::fs::read(&tmp_path).await.ok()?;
    if png_data.is_empty() {
        return None;
    }

    // Don't bother deleting the temp file - we'll overwrite it next time
    
    let img = image::load_from_memory_with_format(&png_data, image::ImageFormat::Png).ok()?;
    let rgb_img = img.to_rgb8();
    let (w, h) = rgb_img.dimensions();

    let mut jpeg_buf = Vec::new();
    let encoder = jpeg_encoder::Encoder::new(&mut jpeg_buf, 80);
    match encoder.encode(rgb_img.as_raw(), w as u16, h as u16, jpeg_encoder::ColorType::Rgb) {
        Ok(()) => Some(jpeg_buf),
        Err(_) => None,
    }
}

/// Main capture loop
pub async fn run_capture_loop(
    udid: String,
    frame_tx: broadcast::Sender<Arc<Vec<u8>>>,
    latest_tx: watch::Sender<Option<Arc<Vec<u8>>>>,
    fps: u32,
    quality: u8,
) -> anyhow::Result<()> {
    let frame_interval = Duration::from_secs_f64(1.0 / fps as f64);

    info!("Looking for Simulator window...");

    let mut window_id: Option<u32> = None;
    let mut attempts = 0;

    while window_id.is_none() && attempts < 100 {
        if let Some((wid, _bounds)) = find_simulator_window(&udid) {
            window_id = Some(wid);
            info!("Found Simulator window with ID: {}", wid);
        } else {
            attempts += 1;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    // Always use simctl fallback for now - CGWindowListCreateImage requires 
    // Screen Recording permission which may hang without a visible prompt
    if window_id.is_some() {
        info!("Found Simulator window but using simctl capture for reliability");
        window_id = None;
    } else {
        warn!("Could not find Simulator window via CGWindowList, using simctl fallback");
    }

    info!("Starting capture loop at {}fps, quality={}", fps, quality);

    let mut frame_count: u64 = 0;
    let mut last_fps_log = Instant::now();
    let mut fps_frame_count: u64 = 0;

    loop {
        let frame_start = Instant::now();

        let jpeg_data = if let Some(wid) = window_id {
            let q = quality;
            let result = tokio::task::spawn_blocking(move || {
                capture_window_frame_quality(wid, q)
            })
            .await
            .ok()
            .flatten();

            if result.is_none() {
                warn!("CGWindowListCreateImage failed for window {}. Trying simctl fallback...", wid);
                // Fall back to simctl for this frame
                let fallback = capture_via_simctl(&udid).await;
                if fallback.is_some() {
                    info!("simctl fallback succeeded - screen recording permission may be needed for CGWindowListCreateImage");
                    // Switch permanently to simctl mode
                    window_id = None;
                }
                fallback
            } else {
                result
            }
        } else {
            capture_via_simctl(&udid).await
        };

        if let Some(data) = jpeg_data {
            if frame_count == 0 {
                info!("First frame captured! Size: {} bytes", data.len());
            }
            let data = Arc::new(data);
            let _ = frame_tx.send(data.clone());
            let _ = latest_tx.send(Some(data));
            frame_count += 1;
            fps_frame_count += 1;
        } else if frame_count == 0 {
            warn!("Failed to capture frame (attempt {})", fps_frame_count + 1);
            fps_frame_count += 1;
        }

        if last_fps_log.elapsed() >= Duration::from_secs(5) {
            let actual_fps = fps_frame_count as f64 / last_fps_log.elapsed().as_secs_f64();
            info!("Capture FPS: {:.1} (total frames: {})", actual_fps, frame_count);
            last_fps_log = Instant::now();
            fps_frame_count = 0;
        }

        let elapsed = frame_start.elapsed();
        if elapsed < frame_interval {
            tokio::time::sleep(frame_interval - elapsed).await;
        }
    }
}
