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

android {
    namespace = "com.ayrovi.worker"
    compileSdk = 35

    signingConfigs {
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
        versionCode = 42
        versionName = "1.4.0-pilot"
        buildConfigField("String", "API_BASE_URL", "\"${apiBaseUrl.replace("\\", "\\\\").replace("\"", "\\\"")}\"")
        buildConfigField("boolean", "WORKER_LEGACY_FALLBACK", legacyFallback.get().toString())
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Unsigned by default. Production signing belongs to the managed release pipeline.
            signingConfig = null
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
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.12.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
