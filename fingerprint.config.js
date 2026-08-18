/**
 * Fingerprint inputs for the `fingerprint` runtimeVersion policy.
 *
 * A native module's android/ directory accumulates build output — Gradle's
 * build/, .gradle/, .cxx/, and the Eclipse metadata (.project, .classpath,
 * .settings) that a Java language server writes when it auto-imports every
 * Gradle project it can see, node_modules included. None of it is source: it
 * is regenerated on demand and differs between this laptop and a clean
 * checkout.
 *
 * Left un-ignored it makes the runtime version UNSTABLE — it moved between two
 * consecutive resolves here, and an EAS build (which installs from the
 * lockfile and so never has the artifacts) computed a different hash than the
 * machine that would publish the update, which is exactly the mismatch
 * expo-updates refuses to build through.
 *
 * Only build output is listed. Each package's own build/ — the compiled JS
 * that actually ships, e.g. expo-modules-core/build — is deliberately NOT
 * ignored, so a real dependency change still moves the fingerprint.
 */
module.exports = {
  ignorePaths: [
    // Gradle / Kotlin / CMake output
    '**/node_modules/**/.gradle/**/*',
    '**/node_modules/**/.cxx/**/*',
    '**/node_modules/**/.kotlin/**/*',
    // Eclipse metadata written by a Java language server auto-importing
    // every Gradle project in the workspace, node_modules included
    '**/node_modules/**/.settings/**/*',
    '**/node_modules/**/.classpath',
    '**/node_modules/**/.project',
    // compiled output, scoped so a package's own shipped build/ still counts
    '**/node_modules/**/android/build/**/*',
    '**/node_modules/**/android/bin/**/*',
    '**/node_modules/**/expo-module-gradle-plugin/build/**/*',
    '**/node_modules/**/expo-module-gradle-plugin/bin/**/*',
  ],
};
