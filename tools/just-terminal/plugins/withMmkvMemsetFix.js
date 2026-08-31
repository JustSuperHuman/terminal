const { withPodfile } = require("expo/config-plugins");

// MMKVCore (pulled in by @kesha-antonov/react-native-background-downloader
// for download-state persistence) calls memset_s, which Apple's SDK headers
// only declare when __STDC_WANT_LIB_EXT1__ is defined before <string.h>. The
// iOS 26.4 SDK on EAS's Xcode image enforces this, failing the build with
// "use of undeclared identifier 'memset_s'" in Core/aes/AESCrypt.cpp. Define
// it on the command line (-D precedes all includes) for just that pod target.
const MARKER = "post_install do |installer|";
const PATCH = `${MARKER}
    installer.pods_project.targets.each do |target|
      next unless target.name == 'MMKVCore'
      target.build_configurations.each do |build_configuration|
        defs = Array(build_configuration.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] || '$(inherited)')
        defs << '__STDC_WANT_LIB_EXT1__=1' unless defs.include?('__STDC_WANT_LIB_EXT1__=1')
        build_configuration.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] = defs
      end
    end`;

module.exports = function withMmkvMemsetFix(config) {
  return withPodfile(config, (podfileConfig) => {
    const { contents } = podfileConfig.modResults;
    if (!contents.includes(MARKER)) {
      throw new Error("withMmkvMemsetFix: could not find the Podfile post_install block to patch.");
    }
    if (!contents.includes("__STDC_WANT_LIB_EXT1__")) {
      podfileConfig.modResults.contents = contents.replace(MARKER, PATCH);
    }
    return podfileConfig;
  });
};
