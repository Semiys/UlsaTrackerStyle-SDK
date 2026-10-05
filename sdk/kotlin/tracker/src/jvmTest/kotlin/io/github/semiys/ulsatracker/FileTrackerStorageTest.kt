package io.github.semiys.ulsatracker

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class FileTrackerStorageTest {
    @Test fun `journal survives reopen and rejects a second concurrent owner`() = runTest {
        val root = Files.createTempDirectory("ulsa-jvm-test-").toFile()
        val one = FileTrackerStorage(root)
        val two = FileTrackerStorage(root)
        try {
            one.write("{\"saved\":true}")
            assertTrue(runCatching { two.read() }.isFailure)
            one.close()
            assertEquals("{\"saved\":true}", two.read())
            two.write("{\"saved\":false}")
            two.close()
            val reopened = FileTrackerStorage(root)
            try { assertEquals("{\"saved\":false}", reopened.read()) }
            finally { reopened.close() }
        } finally {
            one.close(); two.close()
            check(root.canonicalFile.parentFile == java.io.File(System.getProperty("java.io.tmpdir")).canonicalFile && root.name.startsWith("ulsa-jvm-test-"))
            root.deleteRecursively()
        }
    }
}
