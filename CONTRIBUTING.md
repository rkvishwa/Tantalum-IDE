# Contributing to Tantalum IDE

First off, thank you for considering contributing to Tantalum IDE! It's people like you that make open-source tools better for everyone.

The following is a set of guidelines for contributing to Tantalum IDE. These are guidelines, not rules. Use your best judgment, and feel free to propose changes to this document in a pull request.

## Code of Conduct

By participating in this project, you are expected to uphold standard open-source community guidelines: be respectful, welcoming, and inclusive.

## Getting Started

### 1. Fork and Clone

Fork the repository to your own GitHub account and clone it locally:

```bash
git clone https://github.com/your-username/tantalum-ide.git
cd tantalum-ide
```

### 2. Install Dependencies

Tantalum IDE uses npm workspaces. Run the following command from the root directory to install dependencies for both the Electron main process and the React renderer:

```bash
npm install
```

### 3. Run the Development Server

Start the application in development mode:

```bash
npm run dev
```

This will spin up Vite for the React frontend and automatically start the Electron application. Hot Module Replacement (HMR) is enabled for the frontend.

## Project Structure

- `main.js`: The entry point for the Electron main process.
- `preload.js`: The bridge between the main and renderer processes.
- `arduinoHandler.js`: Logic for downloading, configuring, and invoking the Arduino CLI.
- `renderer-react/`: The Vite/React workspace for the UI.
- `functions/`: Appwrite serverless functions for the cloud backend.
- `scripts/`: Various utility scripts for building, testing, and Appwrite migration.

## Development Workflow

### Submitting a Pull Request

1. **Create a new branch:** Use a descriptive name like `feature/add-dark-mode` or `fix/compiler-timeout-bug`.
   ```bash
   git checkout -b your-branch-name
   ```
2. **Make your changes:** Follow the existing coding style. Use TypeScript for new UI components in `renderer-react`.
3. **Test your changes:** Ensure no existing functionality is broken. If you modified cloud functions or APIs, try running the relevant smoke tests:
   ```bash
   npm run smoke:board-code
   ```
4. **Commit your changes:** Write clear and meaningful commit messages.
   ```bash
   git commit -m "Fix compiler timeout bug when verifying large sketches"
   ```
5. **Push and open a PR:** Push your branch to your fork and open a Pull Request against the `main` branch of the upstream repository.

### Coding Guidelines

- **Formatting:** We use Prettier for code formatting. Please ensure your editor is configured to format on save, or run the formatter manually.
- **Electron Security:** Do not expose raw Node.js APIs in the renderer. Always use `contextBridge` in `preload.js` and validate input in IPC handlers within `main.js`.
- **React Components:** Use functional components and hooks. Maintain modularity by keeping components small and focused.

## Reporting Bugs

If you find a bug, please create an Issue on GitHub. Include:
1. Your operating system and version.
2. The version of Tantalum IDE you are using.
3. Steps to reproduce the bug.
4. Any relevant logs or console output (Check the Developer Tools in the IDE).

## Suggesting Enhancements

Have an idea to make Tantalum IDE better? We'd love to hear it! Open an Issue and tag it as an enhancement. Provide as much detail as possible about the use case and how you envision the feature working.

## Security Vulnerabilities

If you discover a security vulnerability, please do NOT report it in public issues. Refer to our [Security Policy](SECURITY.md) for instructions on how to responsibly disclose the issue.
