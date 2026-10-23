/** Closed, model-free history makes test sessions visible in DSH's real sidebar. */
export const name = 'power-type-history-fixture'
export const inject = ['sessions']

export function apply(ctx) {
  ctx.on('session/created', (session) => {
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })
}
