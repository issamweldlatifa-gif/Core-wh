# Keep kotlinx-serialization generated serializers.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keep,includedescriptorclasses class com.ayrovi.worker.**$$serializer { *; }
-keepclassmembers class com.ayrovi.worker.** {
    *** Companion;
}
-keepclasseswithmembers class com.ayrovi.worker.** {
    kotlinx.serialization.KSerializer serializer(...);
}
