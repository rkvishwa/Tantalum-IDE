# Security Policy

The Tantalum IDE maintainers take security seriously. This document outlines our security policy and how to responsibly disclose security vulnerabilities.

## Supported Versions

Currently, only the latest major release of Tantalum IDE is actively supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in Tantalum IDE, its cloud functions, or the Tantalum Runtime, please **DO NOT** open a public issue on GitHub. 

Instead, responsibly disclose the vulnerability by sending an email to our security contact:

**Email:** [hello@knurdz.org](mailto:hello@knurdz.org)

Please include the following information in your report:
- A description of the vulnerability.
- Steps to reproduce the issue.
- The environment and operating system where it occurs.
- Potential impact or attack vectors.
- Any suggested remediations (if known).

### Response Timeline

1. **Acknowledgment:** We will acknowledge receipt of your vulnerability report within 48 hours.
2. **Triage:** We will investigate and confirm the vulnerability, keeping you informed of our progress.
3. **Patching:** We will work to resolve the issue as quickly as possible. Once a patch is ready, we will notify you before the public release.
4. **Disclosure:** Once the vulnerability is patched and an update has been made available to users, we will publicly disclose the vulnerability and acknowledge your contribution (unless you prefer to remain anonymous).

## Best Practices

- **API Keys & Secrets:** Never commit your Appwrite API keys, MQTT passwords, or AI Provider keys to the repository. The IDE and setup scripts use `.env` files or secure command-line injections.
- **Electron Security:** The UI (Renderer process) is intentionally restricted from direct Node.js access. IPC channels are strictly validated to prevent Remote Code Execution (RCE) via malicious sketch code or malicious Appwrite responses.
- **Over-The-Air (OTA) Delivery:** All firmware OTA updates require secure HTTPS connections to the Appwrite bucket or encrypted MQTT payloads where applicable.

Thank you for helping keep Tantalum IDE secure!
