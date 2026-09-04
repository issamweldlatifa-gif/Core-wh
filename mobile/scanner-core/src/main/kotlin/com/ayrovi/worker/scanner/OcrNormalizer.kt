package com.ayrovi.worker.scanner

object OcrNormalizer {
    fun candidates(text: String): List<String> = text
        .uppercase()
        .lines()
        .flatMap { line -> line.split(Regex("\\s+|[,;|]")) }
        .map { it.trim().trim('.', ':', '-', '_') }
        .filter { it.length >= 3 && it.any(Char::isLetterOrDigit) }
        .distinct()
}
