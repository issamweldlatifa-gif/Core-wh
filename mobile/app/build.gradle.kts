import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

val apiBaseUrl = providers.gradleProperty("ayroviApiBaseUrl")
    .orElse(providers.environmentVariable("AYROVI_API_BASE_URL"))
    .orElse("https://core-wh.onrender.com/api").get().trimEnd('/')
val apiUri = URI(apiBaseUrl)
require(apiUri.scheme == "https" && !apiUri.host.isNullOrBlank() && apiUri.rawUserInfo == null && apiUri.rawQuery == null && apiUri.rawFragment == null) {
    "AYROVI API root must be a trusted HTTPS URL without credentials/query/fragment."
}
val legacyFallback = providers.gradleProperty("workerLegacyFallback").map(String::toBooleanStrict).orElse(false)

val signingStore = providers.environmentVariable("AYROVI_SIGNING_STORE_FILE").orNull
val signingAlias = providers.environmentVariable("AYROVI_SIGNING_KEY_ALIAS").orNull
val signingStorePassword = providers.environmentVariable("AYROVI_SIGNING_STORE_PASSWORD").orNull
val signingKeyPassword = providers.environmentVariable("AYROVI_SIGNING_KEY_PASSWORD").orNull
val releaseSigningConfigured = listOf(signingStore, signingAlias, signingStorePassword, signingKeyPassword).all { !it.isNullOrBlank() }

android {
    namespace = "com.ayrovi.worker"
    compileSdk = 35

    signingConfigs {
        if (releaseSigningConfigured) create("managedRelease") {
            storeFile = file(signingStore!!)
            storePassword = signingStorePassword
            keyAlias = signingAlias
            keyPassword = signingKeyPassword
            enableV1Signing = true
            enableV2Signing = true
        }
        // QA installable builds, signed with v1+v2 so sideloading works on
        // every Android >= minSdk. Replace with a private keystore for any
        // managed/internal distribution that must update in place.
        getByName("debug") {
            enableV1Signing = true
            enableV2Signing = true
        }
    }

    defaultConfig {
        applicationId = "com.ayrovi.worker"
        minSdk = 26
        targetSdk = 35
        versionCode = 73
        versionName = "1.8.0-batch.6"
        buildConfigField("String", "API_BASE_URL", "\"${apiBaseUrl.replace("\\", "\\\\").replace("\"", "\\\"")}\"")
        buildConfigField("boolean", "WORKER_LEGACY_FALLBACK", legacyFallback.get().toString())
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            // v1.7.5 modern-build pass: R8 code+resource shrinking ON.
            // Obfuscation stays OFF (-dontobfuscate) on purpose: reflection
            // safety first (serialization/CameraX/MLKit), shrinking still
            // strips dead code and resources. Consumer rules ship with the
            // libraries; the project rules keep the generated serializers.
            isMinifyEnabled = true
            isShrinkResources = true
            // Unsigned by default. Production signing belongs to the managed release pipeline.
            signingConfig = if (releaseSigningConfigured) signingConfigs.getByName("managedRelease") else null
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        unitTests.all { it.useJUnitPlatform() }
    }
}

kotlin { jvmToolchain(17) }

dependencies {
    implementation(project(":worker-core"))
    implementation(project(":design-system"))
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.activity:activity-compose:1.10.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    // v1.8 batch labels: QR ENCODING (zxing core — pure java, no permissions).
    // ML Kit stays the READER; this only renders Batch/Unit label codes.
    implementation("com.google.zxing:core:3.5.3")
    implementation("com.google.mlkit:text-recognition:16.0.1")
    // Push notifications. The google-services PLUGIN is deliberately NOT
    // applied: it fails the build when google-services.json is absent, and
    // the pilot APK must keep building without Firebase credentials. The
    // library alone compiles fine; AyroviMessagingService initialises
    // defensively and simply stays dormant until a real google-services.json
    // is added to app/. See docs/PUSH-SETUP.md.
    implementation("com.google.firebase:firebase-messaging:24.1.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.12.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    // Unified-scanner UI tests grant CAMERA up front so the camera tools can be
    // exercised head-less on the CI emulator (MASTER ORDER §34).
    androidTestImplementation("androidx.test:rules:1.6.1")
    // JVM unit tests (ViewModel regression tests) — same stack as :worker-core.
    testImplementation(kotlin("test-junit5"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testRuntimeOnly("org.junit.jupiter:junit-jupiter-engine:5.10.2")
}

// No debug-signed or unsigned artifact can be advertised as a successful Release build.
val verifyManagedReleaseSigning = tasks.register("verifyManagedReleaseSigning") {
    doLast {
        check(releaseSigningConfigured) { "Release signing is not configured. Supply the managed AYROVI_SIGNING_* environment through the approved secret store." }
        check(file(signingStore!!).isFile) { "The managed release keystore file is unavailable." }
    }
}
tasks.matching { it.name == "assembleRelease" || it.name == "bundleRelease" || it.name == "packageRelease" }.configureEach {
    dependsOn(verifyManagedReleaseSigning)
}
