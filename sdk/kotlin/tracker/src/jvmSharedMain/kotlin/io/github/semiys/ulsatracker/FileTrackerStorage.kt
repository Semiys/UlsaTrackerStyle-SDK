package io.github.semiys.ulsatracker

import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Private directory on Android; a file lock prevents two SDKs from owning the same journal. */
internal class FileTrackerStorage(private val directory: File) : TrackerStorage {
    private var lockFile: RandomAccessFile? = null
    private var lock: java.nio.channels.FileLock? = null
    private val stateFile = File(directory, "queue.json")

    private fun acquire() {
        if (lock != null) return
        check(directory.isDirectory || directory.mkdirs()) { "Could not create analytics storage" }
        val file = RandomAccessFile(File(directory, "queue.lock"), "rw")
        try { lock = file.channel.tryLock() ?: error("Analytics queue already has an owner"); lockFile = file }
        catch (error: Exception) { file.close(); throw error }
    }

    override suspend fun read(): String? = withContext(Dispatchers.IO) {
        acquire()
        if (!stateFile.exists()) null else {
            check(stateFile.length() <= 64 * 1_024 * 1_024) { "Analytics journal too large" }
            stateFile.readText(Charsets.UTF_8)
        }
    }

    override suspend fun write(state: String): Unit = withContext(Dispatchers.IO) {
        acquire()
        val temporary = File(directory, "queue.json.tmp")
        try {
            FileOutputStream(temporary).use { output -> output.write(state.toByteArray(Charsets.UTF_8)); output.fd.sync() }
            try { Files.move(temporary.toPath(), stateFile.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING) }
            catch (_: AtomicMoveNotSupportedException) { Files.move(temporary.toPath(), stateFile.toPath(), StandardCopyOption.REPLACE_EXISTING) }
        } finally { if (temporary.exists()) temporary.delete() }
    }

    override suspend fun close(): Unit = withContext(Dispatchers.IO) {
        try { lock?.release() } finally { lockFile?.close(); lock = null; lockFile = null }
    }
}
