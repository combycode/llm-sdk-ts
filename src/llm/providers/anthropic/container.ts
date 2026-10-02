/** Anthropic's code-execution container, and the skills loaded into it.
 *
 *  The container is the sandbox Anthropic's code execution tool runs in. It used to
 *  be invisible: we sent no `container` and dropped the one the response carried, so
 *  a caller could neither reuse a warm container nor load a skill into it.
 *
 *  Measured 2026-10-02, all on a plain key with NO beta header (the param is GA):
 *
 *  - A turn that runs code answers with `container: {id, expires_at}` — about five
 *    minutes of life, so reuse is a real option rather than a theoretical one.
 *  - Passing `{id}` back REUSES it: the same id comes out again.
 *  - `{skills: [{type:'anthropic', skill_id:'xlsx'}]}` is accepted and VALIDATED
 *    server-side — a skill that does not exist is a `400 Unknown Anthropic skill`,
 *    not a silent ignore, so a typo fails loudly. `GET /v1/skills` lists the
 *    built-in ones (`xlsx`, `pptx`, `pdf`, …) and is GA too.
 *  - A requested `version: 'latest'` comes back RESOLVED (`'20260914'`), which is
 *    why the response's version is worth reporting rather than echoing the request.
 *  - Asking for skills on a turn that never runs code answers `container: null`:
 *    the container is created when it is needed, not when it is requested.
 *
 *  And the one shape a reasonable guess gets wrong: when STREAMING, `message_start`
 *  carries `container: null` and the real container arrives on
 *  `message_delta.delta.container`. Reading the opening frame would report `null`
 *  for every streamed turn.
 */

/** A skill to load into the container.
 *
 *  `skillId` is the skill's own id (`'xlsx'`, or a custom skill's id), and `version`
 *  accepts `'latest'`. camelCase here, `skill_id` on the wire. */
export interface AnthropicSkillRef {
  type: 'anthropic' | 'custom';
  skillId: string;
  version?: string;
}

/** What a caller asks for: reuse a container, load skills into it, or both. */
export interface AnthropicContainerRequest {
  /** An id from an earlier response's `container.id`, to reuse that container
   *  instead of paying for a cold one. It expires — see `expiresAt`. */
  id?: string;
  skills?: AnthropicSkillRef[];
}

/** The container a turn actually used, as reported back. */
export interface ContainerInfo {
  id: string;
  /** When it dies, as the provider sent it (ISO 8601). Pass `id` back before this
   *  to reuse it; after, a new container is created. */
  expiresAt: string;
  /** The skills loaded, with versions RESOLVED — `'latest'` becomes the version
   *  that actually ran, which is the one worth recording. */
  skills?: AnthropicSkillRef[];
}

/** `providerOptions.container` -> the wire's `container`.
 *
 *  Only the keys the caller set: sending `skills: []` or `id: undefined` would be a
 *  request for something they did not ask for. */
export function toWireContainer(req: AnthropicContainerRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (req.id) out.id = req.id;
  if (req.skills?.length) out.skills = req.skills.map(wireSkill);
  return out;
}

/** One skill ref, snake_cased, or a clear error.
 *
 *  A malformed entry THROWS rather than travelling. Letting it through produces a
 *  server-side 400 about a field the caller never wrote (`{}` once `undefined` is
 *  dropped from the JSON), and dropping it silently would load no skill while the
 *  caller believes one is loaded -- the same silent-success failure the shell tool's
 *  warning exists to prevent. Both are worse than saying so here, where the mistake
 *  is. */
function wireSkill(skill: AnthropicSkillRef): Record<string, unknown> {
  if (skill?.type !== 'anthropic' && skill?.type !== 'custom') {
    throw new Error(
      `container.skills[].type must be 'anthropic' or 'custom'; got ${JSON.stringify(skill?.type)}`,
    );
  }
  if (typeof skill.skillId !== 'string' || !skill.skillId) {
    throw new Error(
      `container.skills[].skillId must be a non-empty string; got ${JSON.stringify(skill.skillId)}`,
    );
  }
  return {
    type: skill.type,
    skill_id: skill.skillId,
    ...(skill.version ? { version: skill.version } : {}),
  };
}

/** The wire's `container` -> `ContainerInfo`, or `undefined` when there was none.
 *
 *  `null` is the normal answer for a turn that never ran code, so it is not an
 *  error and not worth a warning — it means no container was created. */
export function containerFromWire(raw: unknown): ContainerInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string') return undefined;
  const skills = Array.isArray(c.skills)
    ? c.skills
        .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
        .map((s) => ({
          type: (s.type === 'custom' ? 'custom' : 'anthropic') as 'anthropic' | 'custom',
          skillId: typeof s.skill_id === 'string' ? s.skill_id : '',
          ...(typeof s.version === 'string' ? { version: s.version } : {}),
        }))
    : undefined;
  return {
    id: c.id,
    expiresAt: typeof c.expires_at === 'string' ? c.expires_at : '',
    ...(skills?.length ? { skills } : {}),
  };
}
