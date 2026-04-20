/**
 * agent-simulator — Metro Config Plugin
 *
 * Add to your metro.config.js:
 *
 *   const { withAgentSimulator } = require('agent-simulator/runtime/metro-plugin');
 *   module.exports = withAgentSimulator(getDefaultConfig(__dirname));
 *
 * This adds the inspector bridge to your app's module resolution so taps /
 * inspect requests from the agent-simulator web UI (or an MCP client) can
 * pick up React component info from the running app.
 *
 * `withSimPreview` is kept as an alias for backwards compatibility with
 * the 0.1.x / 0.2.x name.
 */

const path = require('path');

function withAgentSimulator(config) {
  const bridgePath = require.resolve('./inspector-bridge');
  const runtimeDir = path.resolve(__dirname);
  // The consuming app's node_modules (one level up from
  // node_modules/agent-simulator/runtime). When agent-simulator is installed
  // via bun's file: or a symlink, Metro would otherwise try to resolve the
  // bridge's `require('react-native')` against agent-simulator's own
  // node_modules and fail.
  const appRoot =
    (config.projectRoot && path.resolve(config.projectRoot)) || process.cwd();
  const appNodeModules = path.join(appRoot, 'node_modules');
  console.log('[agent-simulator] metro plugin active');
  console.log('[agent-simulator]   bridge      =', bridgePath);
  console.log('[agent-simulator]   watchFolder =', runtimeDir);
  console.log('[agent-simulator]   appModules  =', appNodeModules);

  const originalGetModulesRunBeforeMainModule =
    config.serializer?.getModulesRunBeforeMainModule;

  return {
    ...config,
    serializer: {
      ...config.serializer,
      getModulesRunBeforeMainModule: () => {
        const existing = originalGetModulesRunBeforeMainModule?.() || [];
        return [...existing, bridgePath];
      },
    },
    resolver: {
      ...config.resolver,
      // Preserve the require() resolution against the app's node_modules
      // even when the importing file lives in agent-simulator's out-of-tree
      // runtime directory.
      nodeModulesPaths: [
        ...((config.resolver && config.resolver.nodeModulesPaths) || []),
        appNodeModules,
      ],
      // Metro 0.80+ — don't resolve symlinks to their realpath for module
      // lookup. This keeps `require('react-native')` inside the symlinked
      // bridge resolving against the app's node_modules.
      unstable_enableSymlinks: true,
    },
    // Add the agent-simulator runtime to watchFolders so Metro bundles it.
    watchFolders: [
      ...(config.watchFolders || []),
      runtimeDir,
    ],
  };
}

module.exports = {
  withAgentSimulator,
  // Deprecated alias kept for older sim-preview configs.
  withSimPreview: withAgentSimulator,
};
