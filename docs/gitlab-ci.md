# GitLab CI

The pipeline reuses `myrole/ci-templates` at `v1`, matching the BuildKit and Portainer setup in `myrole-3`. The GitLab project and the user starting the pipeline must have access to that template project. Use a Docker executor runner that supports the shared BuildKit template and PostgreSQL services.

## Pipeline behavior

- Branch pushes, merge requests and manual branch pipelines run TypeScript checks, the production build and the existing unit/API tests against an isolated PostgreSQL 17 service. Feature-branch push pipelines are suppressed while a merge request is open; default-branch and staging push pipelines always run.
- Successful default-branch pipelines publish `$CI_REGISTRY_IMAGE:latest` and `:commit-$CI_COMMIT_SHA`.
- Successful `staging` pipelines publish `$CI_REGISTRY_IMAGE:staging` and `:commit-$CI_COMMIT_SHA`.
- Other branches and merge requests only run checks. Git tags do not start this pipeline.
- Production/staging deployments run after checks and image publication, only when the corresponding webhook URL is configured. The shared deployment template serializes deployments per environment.

The checks call `node --test` directly after `pnpm build`: `pnpm test` would start a local PostgreSQL container through Docker Compose, while GitLab provides the database as a service. Browser, real-mail and container-persistence integration checks remain in the existing GitHub Actions workflow.

## Portainer configuration

Configure these CI/CD variables in GitLab, following the existing `myrole-3` setup:

| Variable | Purpose |
| --- | --- |
| `PORTAINER_WEBHOOK_URL` | Production stack update webhook; omit to disable automatic production deployment. |
| `PORTAINER_WEBHOOK_SECRET` | Optional production webhook secret sent in `x-webhook-secret`. |
| `PORTAINER_STAGING_WEBHOOK_URL` | Staging stack update webhook; omit to disable automatic staging deployment. |
| `PORTAINER_STAGING_WEBHOOK_SECRET` | Optional staging webhook secret. |

Keep webhook URLs and secrets masked. Protect production variables and the default branch; protect `staging` too if staging variables are protected. BuildKit registry authentication uses GitLab's predefined registry credentials. The shared template also supports the same optional `BUILDKIT_MIRROR_HOST` and `BUILDKIT_TLS_CA` / `BUILDKIT_TLS_CERT` / `BUILDKIT_TLS_KEY` settings as `myrole-3`.

Use [the deployment Compose file](../deploy/compose.yaml) with `POSTFOLD_IMAGE` set to the actual GitLab registry image followed by `:latest` in production or `:staging` in staging. Both `api` and `web` use this one image. Configure Portainer with registry pull credentials for the private GitLab registry and enable pulling the updated image when the webhook runs. Use separate stacks, databases and secrets for staging and production. Application environment variables and secret files stay in the deployment configuration, outside CI.

For a manual deployment or rollback, use the immutable `:commit-FULL_COMMIT_SHA` tag and follow [the backup and update procedure](docker.md#update-without-losing-shared-data). This pipeline does not run the application-specific backup or release scripts from `myrole-3`.
