/** Expo SDK 53 + NativeWind 4 + expo-router. */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    plugins: [
      // Reanimated's plugin MUST be listed last.
      'react-native-reanimated/plugin',
    ],
  };
};
