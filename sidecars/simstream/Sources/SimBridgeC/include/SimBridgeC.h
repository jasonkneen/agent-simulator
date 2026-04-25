#pragma once

#include <stdbool.h>
#include <IOSurface/IOSurface.h>

#ifdef __cplusplus
extern "C" {
#endif

bool SPBridgeStart(const char * _Nonnull udid, char * _Nullable * _Nullable errorOut);
CF_RETURNS_RETAINED IOSurfaceRef _Nullable SPBridgeCopySurface(void);
void SPBridgeStop(void);
void SPBridgeFreeCString(char * _Nullable s);

#ifdef __cplusplus
}
#endif
