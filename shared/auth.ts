export type Viewer = { id: string; name: string; email: string; provider: 'keycloak'; admin?: boolean }

export function authMode() {
  const mode = process.env.POSTFOLD_AUTH ?? 'basic'
  if (mode !== 'basic' && mode !== 'keycloak') throw new Error('POSTFOLD_AUTH must be basic or keycloak.')
  return mode
}
