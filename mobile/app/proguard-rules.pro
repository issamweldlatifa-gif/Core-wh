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

# v1.7.5: shrink without renaming — reflection safety first.
-dontobfuscate
