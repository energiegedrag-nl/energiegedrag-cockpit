# Contributing

Thank you for helping. This repository follows the conventions of [energiegedrag-nl](https://github.com/energiegedrag-nl).

## Workflow

- Work in a **feature branch** (`feat/...`, `fix/...`, `docs/...`) and open a **pull request** to the default branch.
  Long-lived release lines (for example `release/v3` for firmware) get their own base branch.
- The checks of the pull request (build, tests, lint) must pass before merging. Keep pull requests small and focused.
- Write commit messages that say *why*, not only *what*. Reference issues or TODO items where relevant.
- Releases are tagged `vMAJOR.MINOR.PATCH` (semantic versioning).

## Conventions

- Physical quantities in names follow [physiquant__unit](https://github.com/energiegedrag-nl/physiquant__unit)
  (for example `temp_in__degC`, `e_use_cum__kWh`, `occupancy__bool`, `heating_mode__cat`).
- No secrets and no personal data in the repository or its history. Configuration that differs per deployment
  (organisation, domain, keys) comes from settings or environment variables, not from code.
- Open work is listed in `TODO.md` (lead item in one repository, links from the others).

## AI assistance

AI tools may be used under the author's direction and review. Add a `Co-Authored-By:` trailer to commits made with
their help and mention it in the README under *Credits*; the author remains responsible for the content.
