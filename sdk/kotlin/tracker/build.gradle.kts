import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("multiplatform")
    kotlin("plugin.serialization")
    id("com.android.kotlin.multiplatform.library")
    `maven-publish`
}

group = "io.github.semiys.ulsatracker"
version = "0.2.0"

kotlin {
    android {
        namespace = "io.github.semiys.ulsatracker"
        compileSdk = 37
        minSdk = 26
        compilerOptions { jvmTarget.set(JvmTarget.JVM_11) }
    }
    jvm { compilerOptions { jvmTarget.set(JvmTarget.JVM_11) } }
    sourceSets {
        commonMain.dependencies {
            api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
            implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
            implementation("io.ktor:ktor-client-core:3.6.0")
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
        }
        val jvmSharedMain by creating {
            dependsOn(commonMain.get())
            dependencies { implementation("io.ktor:ktor-client-okhttp:3.6.0") }
        }
        androidMain.get().dependsOn(jvmSharedMain)
        jvmMain.get().dependsOn(jvmSharedMain)
        jvmTest.get().dependsOn(commonTest.get())
        jvmTest.dependencies {
            implementation("io.ktor:ktor-client-mock:3.6.0")
            implementation(kotlin("test-junit"))
        }
    }
}

tasks.withType<Test>().configureEach {
    // Passed explicitly by the local end-to-end check; keys stay out of test reports.
    listOf("ULSA_TEST_ENDPOINT", "ULSA_TEST_INGEST_KEY", "ULSA_TEST_READ_KEY").forEach { name ->
        providers.environmentVariable(name).orNull?.let { environment(name, it) }
    }
}
