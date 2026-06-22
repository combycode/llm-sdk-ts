// Minimal real MCP server over stdio (NDJSON JSON-RPC) for integration tests.
// Implements just: initialize, notifications/initialized, tools/list, tools/call.
// One tool: add(a, b) -> text "a+b".

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
    nl = buf.indexOf('\n');
  }
});

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function log(data) {
  send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data } });
}

// task state (P4): taskId -> { name, args, polls, createdAt, cancelled }
let taskSeq = 0;
const tasks = {};

function handle(msg) {
  // Responses to OUR server->client requests -> report what came back via a log.
  if (msg.method === undefined && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    if (msg.id === 9999) return log('pong-received');
    if (msg.id === 8001) return log(`sampled:${msg.result?.content?.text ?? 'ERR'}`);
    if (msg.id === 8002) return log(`roots:${JSON.stringify(msg.result?.roots ?? 'ERR')}`);
    if (msg.id === 8003) return log(`elicit:${msg.result?.action ?? 'ERR'}`);
    return;
  }
  switch (msg.method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
          serverInfo: { name: 'fixture', version: '0.0.1' },
        },
      });
    case 'resources/list':
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { resources: [{ uri: 'mem://greeting', name: 'greeting', mimeType: 'text/plain' }] },
      });
    case 'resources/read':
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { contents: [{ uri: msg.params.uri, mimeType: 'text/plain', text: 'hello from resource' }] },
      });
    case 'prompts/list':
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { prompts: [{ name: 'greet', description: 'Greet someone', arguments: [{ name: 'who', required: true }] }] },
      });
    case 'prompts/get':
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { messages: [{ role: 'user', content: { type: 'text', text: `Say hi to ${msg.params.arguments.who}` } }] },
      });
    case 'logging/setLevel':
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: msg.params.level, data: 'level set' } });
      return;
    case 'completion/complete':
      return send({ jsonrpc: '2.0', id: msg.id, result: { completion: { values: ['Alex', 'Alice'], total: 2, hasMore: false } } });
    case 'notifications/initialized':
      // Kick off server->client traffic to exercise the bidirectional path.
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      send({ jsonrpc: '2.0', id: 9999, method: 'ping' });
      return;
    case 'tools/list':
      return send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'add',
              description: 'Add two numbers',
              inputSchema: {
                type: 'object',
                properties: { a: { type: 'number' }, b: { type: 'number' } },
                required: ['a', 'b'],
              },
            },
            { name: 'probe_server', description: 'Trigger server->client sampling/roots/elicitation', inputSchema: { type: 'object', properties: {} } },
          ],
        },
      });
    case 'tasks/get': {
      const t = tasks[msg.params.taskId];
      if (!t) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown task' } });
      t.polls++;
      const status = t.cancelled ? 'cancelled' : t.polls >= 2 ? 'completed' : 'working';
      return send({ jsonrpc: '2.0', id: msg.id, result: { taskId: msg.params.taskId, status, ttl: null, createdAt: t.createdAt, lastUpdatedAt: new Date().toISOString(), pollInterval: 5 } });
    }
    case 'tasks/result': {
      const t = tasks[msg.params.taskId];
      return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String((t.args.a ?? 0) + (t.args.b ?? 0)) }] } });
    }
    case 'tasks/list':
      return send({ jsonrpc: '2.0', id: msg.id, result: { tasks: Object.keys(tasks).map((id) => ({ taskId: id, status: 'working', ttl: null, createdAt: tasks[id].createdAt, lastUpdatedAt: tasks[id].createdAt })) } });
    case 'tasks/cancel': {
      const t = tasks[msg.params.taskId];
      if (t) t.cancelled = true;
      return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
    case 'tools/call': {
      const { name, arguments: args } = msg.params;
      if (msg.params.task !== undefined) {
        const taskId = `t${++taskSeq}`;
        const now = new Date().toISOString();
        tasks[taskId] = { name, args, polls: 0, createdAt: now };
        return send({ jsonrpc: '2.0', id: msg.id, result: { task: { taskId, status: 'working', ttl: null, createdAt: now, lastUpdatedAt: now, pollInterval: 5 } } });
      }
      if (name === 'probe_server') {
        // Ask the client to fulfill the three server->client requests.
        send({ jsonrpc: '2.0', id: 8001, method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }], maxTokens: 16 } });
        send({ jsonrpc: '2.0', id: 8002, method: 'roots/list' });
        send({ jsonrpc: '2.0', id: 8003, method: 'elicitation/create', params: { message: 'name?', requestedSchema: { type: 'object' } } });
        return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'probing' }] } });
      }
      if (name === 'add') {
        return send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: String((args.a ?? 0) + (args.b ?? 0)) }] },
        });
      }
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown tool ${name}` } });
    }
    default:
      if (typeof msg.id === 'number') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
      }
  }
}
