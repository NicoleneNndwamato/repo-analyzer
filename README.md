# Repo Analysis Tool (RAT)

A web dashboard for analysing Git repository history.

## Features

- Clone repositories from remote URLs
- Upload repository ZIP files containing `.git`
- Support multiple repositories
- Apply `.mailmap` and manually merge authors
- File, directory, repository, commit-set, and author metrics
- Added lines, removed lines, growth, churn, modifications, modification frequency, churn rate, and ownership
- Filter by author, path, date range, and selected commits
- Skip binary files and detect renames at 50%

## Setup

Requirements: Node.js 18+, Git, and npm.

```bash
npm install
mkdir -p repos uploads
node server.js
