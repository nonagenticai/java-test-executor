#!/usr/bin/env node

// Dependency-free on purpose: the Docker build imports this (via
// scripts/print-pom.js) to bake the offline Maven repository BEFORE npm install
// has run, and importing the service would drag in express + the shared
// executor-common package and execute their module-level side effects.

/**
 * The pom.xml every scaffolded Maven project gets.
 *
 * Hoisted to module scope 2026-08-16 so ONE definition feeds both the runtime
 * scaffold and the image's offline dependency bake (scripts/print-pom.js, called
 * from the Dockerfile). If the two ever drift, the baked /opt/m2 stops matching
 * what the service asks for and every /execute fails offline with a resolution
 * error -- so they must not be able to drift. pom-template.test.js asserts it.
 *
 * checkstyle / pmd / spotbugs are pinned here because the service runs
 * `mvn checkstyle:check`, `mvn pmd:check` and `mvn spotbugs:check` by default
 * (options.runStaticAnalysis !== false). Unpinned, Maven resolves the version
 * from remote metadata, which cannot work in a namespace with no egress -- and
 * `spotbugs:` did not resolve even ONLINE, because its prefix lives under
 * com.github.spotbugs rather than a default plugin group and the plugin was
 * never declared. Measured offline as uid 65532 on a read-only rootfs: test,
 * jacoco:report and all three analyses now BUILD SUCCESS.
 */
const MAVEN_POM_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 
         http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>test-project</artifactId>
    <version>1.0.0</version>
    <packaging>jar</packaging>

    <properties>
        <maven.compiler.source>11</maven.compiler.source>
        <maven.compiler.target>11</maven.compiler.target>
        <junit.version>5.8.2</junit.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.junit.jupiter</groupId>
            <artifactId>junit-jupiter</artifactId>
            <version>\${junit.version}</version>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-surefire-plugin</artifactId>
                <version>3.0.0-M7</version>
            </plugin>
            <plugin>
                <groupId>org.jacoco</groupId>
                <artifactId>jacoco-maven-plugin</artifactId>
                <version>0.8.7</version>
                <executions>
                    <execution>
                        <goals>
                            <goal>prepare-agent</goal>
                        </goals>
                    </execution>
                    <execution>
                        <id>report</id>
                        <phase>test</phase>
                        <goals>
                            <goal>report</goal>
                        </goals>
                    </execution>
                </executions>
            </plugin>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-checkstyle-plugin</artifactId>
                <version>3.6.0</version>
            </plugin>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-pmd-plugin</artifactId>
                <version>3.28.0</version>
            </plugin>
            <plugin>
                <groupId>com.github.spotbugs</groupId>
                <artifactId>spotbugs-maven-plugin</artifactId>
                <version>4.9.7.0</version>
            </plugin>
        </plugins>
    </build>
</project>`;

module.exports = { MAVEN_POM_TEMPLATE };
