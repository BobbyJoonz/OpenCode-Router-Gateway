---
title: "Contributing Guidelines"
description: "Guidelines for contributing to OpenCode Router. Code formatting, test suite execution, and pull request workflows."
---

# Contributing Guidelines

Thank you for your interest in contributing to **OpenCode Router**! We welcome bug reports, feature requests, documentation improvements, and code contributions.

---

## Code of Conduct

Please treat all members of the community with respect, patience, and courtesy.

---

## How to Contribute

### Reporting Issues
- Check the [GitHub Issues](https://github.com/EhsanCreator/OpenCode-Router/issues) page to verify whether the issue has already been reported.
- When opening a new issue, describe the problem clearly, including:
  - Ubuntu version (`lsb_release -a`)
  - Node.js version (`node -v`)
  - OpenCode version (`opencode --version`)
  - Error logs (sanitize any private server endpoints or credentials before posting)

### Developing Locally
1. Fork and clone the repository:
   ```bash
   git clone https://github.com/EhsanCreator/OpenCode-Router.git
   cd OpenCode-Router
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run the automated test suite:
   ```bash
   npm test
   ```

4. Start in development mode:
   ```bash
   npm run dev:backend
   # In another terminal:
   npm run dev:frontend
   ```

---

## Coding Standards
- Write clean, maintainable TypeScript.
- Follow least-privilege security principles: never require root unless strictly necessary.
- Respect host environment isolation: do not modify global OS routing or interfere with other applications.
- Run tests (`npm test`) and ensure the frontend compiles (`npm run build`) before submitting pull requests.

---

## Submitting Pull Requests
1. Create a feature branch:
   ```bash
   git checkout -b feature/my-feature
   ```
2. Commit your changes with descriptive messages:
   ```bash
   git commit -m "feat: add support for custom subscription endpoints"
   ```
3. Push to your branch and submit a Pull Request on GitHub.

---

## License
By contributing to OpenCode Router, you agree that your contributions will be licensed under the project's [MIT License](https://github.com/EhsanCreator/OpenCode-Router/blob/main/LICENSE).
