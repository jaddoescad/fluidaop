import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalGmailSupplementalLabel,
  canonicalGmailTopicLabel,
  GmailLabelApiError,
  GmailLabelClient,
  GmailUserLabel,
  planManagedLabelMutation,
  projectTopicToGmail,
} from './gmailLabelSync.js';

class FakeClient implements GmailLabelClient {
  labels: GmailUserLabel[] = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'topic-old', name: 'Fluid/Old topic', type: 'user' },
  ];
  messageLabels = ['INBOX', 'personal', 'topic-old'];
  mutations: Array<{ add: string[]; remove: string[] }> = [];

  async listLabels() { return this.labels; }
  async createLabel(name: string): Promise<GmailUserLabel> {
    const label = { id: `created-${this.labels.length}`, name, type: 'user' };
    this.labels.push(label);
    return label;
  }
  async renameLabel(id: string, name: string): Promise<GmailUserLabel> {
    const label = this.labels.find((candidate) => candidate.id === id);
    if (!label) throw new Error('missing label');
    label.name = name;
    return label;
  }
  async getMessageLabelIds() { return this.messageLabels; }
  async modifyMessageLabels(_messageId: string, add: string[], remove: string[]) {
    this.mutations.push({ add, remove });
    this.messageLabels = [...new Set([...this.messageLabels.filter((id) => !remove.includes(id)), ...add])];
  }
}

test('uses one canonical managed namespace', () => {
  assert.equal(canonicalGmailTopicLabel('  New   Lead  '), 'Fluid/New Lead');
  assert.equal(canonicalGmailSupplementalLabel('  Employee  '), 'Employee');
});

test('mutation plan preserves personal and system labels', () => {
  assert.deepEqual(
    planManagedLabelMutation(['INBOX', 'personal', 'old'], 'new', ['old', 'new']),
    { addLabelIds: ['new'], removeLabelIds: ['old'] },
  );
});

test('projection swaps only the managed topic and is idempotent', async () => {
  const client = new FakeClient();
  const topics = [
    { id: 1, key: 'old', name: 'Old topic' },
    { id: 2, key: 'new-lead', name: 'New lead' },
  ];
  const mappings = [{ fluidLabelId: 1, gmailLabelId: 'topic-old', gmailLabelName: 'Fluid/Old topic' }];

  const first = await projectTopicToGmail(client, 'message-1', topics[1]!, topics, mappings);
  assert.equal(first.outcome, 'applied');
  assert.deepEqual(client.mutations, [{ add: ['created-2'], remove: ['topic-old'] }]);
  assert.deepEqual(client.messageLabels.sort(), ['INBOX', 'created-2', 'personal'].sort());

  const second = await projectTopicToGmail(client, 'message-1', topics[1]!, topics, mappings);
  assert.equal(second.outcome, 'already-applied');
  assert.equal(client.mutations.length, 1);
});

test('projects Employee as an additive managed role label', async () => {
  const client = new FakeClient();
  const topics = [{ id: 1, key: 'old', name: 'Old topic' }];
  const mappings = [{ fluidLabelId: 1, gmailLabelId: 'topic-old', gmailLabelName: 'Fluid/Old topic' }];

  const first = await projectTopicToGmail(
    client,
    'message-1',
    topics[0]!,
    topics,
    mappings,
    { desiredNames: ['Employee'], managedNames: ['Employee'] },
  );
  assert.equal(first.outcome, 'applied');
  assert.deepEqual(client.mutations, [{ add: ['created-2'], remove: [] }]);
  assert.deepEqual(client.messageLabels.sort(), ['INBOX', 'created-2', 'personal', 'topic-old'].sort());

  const second = await projectTopicToGmail(
    client,
    'message-1',
    topics[0]!,
    topics,
    mappings,
    { desiredNames: ['Employee'], managedNames: ['Employee'] },
  );
  assert.equal(second.outcome, 'already-applied');
  assert.equal(client.mutations.length, 1);
});

test('removes a stale managed Employee label from non-employee mail', async () => {
  const client = new FakeClient();
  client.labels.push({ id: 'employee', name: 'Employee', type: 'user' });
  client.messageLabels.push('employee');
  const topics = [{ id: 1, key: 'old', name: 'Old topic' }];
  const mappings = [{ fluidLabelId: 1, gmailLabelId: 'topic-old', gmailLabelName: 'Fluid/Old topic' }];

  const result = await projectTopicToGmail(
    client,
    'message-1',
    topics[0]!,
    topics,
    mappings,
    { desiredNames: [], managedNames: ['Employee'] },
  );
  assert.equal(result.outcome, 'applied');
  assert.deepEqual(client.mutations, [{ add: [], remove: ['employee'] }]);
  assert.ok(client.messageLabels.includes('personal'));
});

test('adopts a concurrently created Gmail label instead of duplicating it', async () => {
  class ConflictClient extends FakeClient {
    refreshes = 0;

    override async listLabels(refresh = false) {
      if (refresh) {
        this.refreshes += 1;
        this.labels.push({ id: 'concurrent', name: 'Fluid/New lead', type: 'user' });
      }
      return this.labels;
    }

    override async createLabel(_name: string): Promise<GmailUserLabel> {
      throw new GmailLabelApiError(409, 'Label already exists');
    }
  }

  const client = new ConflictClient();
  const topics = [{ id: 2, key: 'new-lead', name: 'New lead' }];
  const result = await projectTopicToGmail(client, 'message-1', topics[0]!, topics, []);
  assert.equal(client.refreshes, 1);
  assert.equal(result.gmailLabelId, 'concurrent');
  assert.deepEqual(client.mutations, [{ add: ['concurrent'], remove: [] }]);
});
