import { describe, expect, it } from 'vitest';
import { loadConfig, setup } from './helpers.js';

describe('publishing and rollback', () => {
  it('publishes a new version without redeploy and rolls back along the activation stack', async () => {
    const { api } = setup();
    let res = await api.get('/api/admin/funnels/workstyle-planner');
    expect(res.body.activeVersion).toBe(1);

    res = await api.post('/api/admin/versions?publish=true').send(loadConfig(2));
    expect(res.status).toBe(201);
    res = await api.post('/api/admin/versions?publish=true').send(loadConfig(3));
    expect((await api.get('/api/admin/funnels/workstyle-planner')).body.activeVersion).toBe(3);

    await api.post('/api/admin/funnels/workstyle-planner/rollback').expect(200);
    expect((await api.get('/api/admin/funnels/workstyle-planner')).body.activeVersion).toBe(2);
    // second rollback continues down the stack (does not toggle back to v3)
    await api.post('/api/admin/funnels/workstyle-planner/rollback').expect(200);
    expect((await api.get('/api/admin/funnels/workstyle-planner')).body.activeVersion).toBe(1);
    await api.post('/api/admin/funnels/workstyle-planner/rollback').expect(409);

    // roll forward again by re-publishing an existing version
    await api.post('/api/admin/funnels/workstyle-planner/versions/3/publish').expect(200);
    expect((await api.get('/api/admin/funnels/workstyle-planner')).body.activeVersion).toBe(3);
  });

  it('treats versions as immutable: identical re-upload is idempotent, changed content is rejected', async () => {
    const { api } = setup();
    const v2 = loadConfig(2);
    expect((await api.post('/api/admin/versions').send(v2)).status).toBe(201);
    expect((await api.post('/api/admin/versions').send(v2)).status).toBe(200);
    const changed = { ...v2, title: 'Changed' };
    expect((await api.post('/api/admin/versions').send(changed)).status).toBe(409);
  });

  it('rejects structurally broken configs with readable errors', async () => {
    const { api } = setup();
    const broken = loadConfig(2);
    broken.version = 9;
    broken.experiment.variants.B.stepSequence.splice(1, 0, 'does_not_exist');
    const res = await api.post('/api/admin/versions').send(broken);
    expect(res.status).toBe(422);
    expect(res.body.details.join(' ')).toMatch(/does_not_exist/);
  });
});

describe('version pinning', () => {
  it('keeps an old session on its version after a new one is published; new sessions get the active version', async () => {
    const { api } = setup();
    const old = (await api.post('/api/sessions').send({})).body.session;
    expect(old.version).toBe(1);

    await api.post('/api/admin/versions?publish=true').send(loadConfig(2));

    const resumed = await api.post('/api/sessions').send({ sessionId: old.id });
    expect(resumed.body.created).toBe(false);
    expect(resumed.body.session.version).toBe(1);
    expect(resumed.body.funnel.version).toBe(1);
    expect(resumed.body.funnel.steps.map((s: { id: string }) => s.id)).not.toContain('meeting_hours');

    const fresh = (await api.post('/api/sessions').send({})).body;
    expect(fresh.session.version).toBe(2);

    // old session can still save state and finish on v1 after v3 publish + rollback to v2
    await api.post('/api/admin/versions?publish=true').send(loadConfig(3));
    await api.post('/api/admin/funnels/workstyle-planner/rollback');
    const answers = { team_size: 8, work_mode: 'remote', priorities: ['focus'], timezone_span: 'global', async_maturity: 'low', tool_count: 6 };
    await api.put(`/api/sessions/${old.id}/state`).send({ answers, path: ['intro', 'result'] }).expect(200);
    const result = await api.post(`/api/sessions/${old.id}/result`).expect(200);
    expect(result.body.resultId).toBe('async_native');
    expect((await api.post('/api/sessions').send({})).body.session.version).toBe(2);
  });

  it('rejects answers to questions that do not exist in the pinned version', async () => {
    const { api } = setup();
    const s = (await api.post('/api/sessions').send({})).body.session;
    await api.post('/api/admin/versions?publish=true').send(loadConfig(2));
    const res = await api.put(`/api/sessions/${s.id}/state`).send({ answers: { meeting_hours: 20 }, path: ['intro'] });
    expect(res.status).toBe(422);
  });
});
