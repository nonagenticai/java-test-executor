#!/usr/bin/env node

/**
 * Print the pom.xml the service scaffolds for Maven projects.
 *
 * Used by the Dockerfile to bake an offline Maven repository at /opt/m2. The
 * runtime namespace has ZERO internet egress (it executes arbitrary submitted
 * test code), so every dependency the generated pom names has to already be in
 * the image or `mvn test` dies at resolution.
 *
 * Printing the template rather than duplicating it is the point: a hand-copied
 * bake pom would silently rot the day someone bumps junit.version, and the
 * failure would only surface in production as a resolution error.
 */

const { MAVEN_POM_TEMPLATE } = require('../src/pom-template');

process.stdout.write(MAVEN_POM_TEMPLATE);
