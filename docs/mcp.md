# MCP tools and the proxy

The user connects each MCP tool one time, and every agent run that your app gives it has it. The real tokens stay in your database. The agent in the sandbox gets only a job token for your proxy.

## Connect a server, one time for each user

```ts
// A server with its own sign-in (MCP authorization, OAuth 2.1 with PKCE)
const c = await agents.connectMcp(userId, 'https://mcp.notion.com/mcp', { name: 'notion' })
if (!c.connected) return Response.json({ signInUrl: c.signInUrl })  // send the browser there; it comes back to /byoa/callback

// A server that takes a token the user pasted
await agents.connectMcp(userId, 'https://mcp.example.com/mcp', { name: 'tasks', bearer: token })

await agents.listMcp(userId)            // [{ name, url }]
await agents.removeMcp(userId, 'notion')
```

- `name`: lower-case letters, digits and `-`, at most 32. A job asks for servers by this name.
- The URL must be `https://` (or `http://` on localhost). With `bearer`, byoa checks the token with one MCP `initialize`, and throws if the server refuses it.
- byoa uses Client ID Metadata Documents when the server supports them (serve `agents.clientMetadata()` at `oauth.clientMetadataUrl`), and Dynamic Client Registration only when it does not.
- The server's sign-in page sends the browser to your `oauth.redirectUrl` route, which calls `agents.finishMcp({ state, code, error })`. It finds the user from the stored `state`, so that route needs no session. A sign-in that does not finish in 15 minutes runs out; call `connectMcp` again.
- byoa refreshes each grant itself, with one refresh owner: your backend. Two jobs that need a refresh at the same time cause one refresh request. Do not refresh or read the tokens in your app's code.

## The proxy and job tokens

Serve `agents.proxy` at `proxyUrl` and at every path below it (`<proxyUrl>/<name>`). It is a fetch handler. For each job, byoa writes an MCP config in the sandbox that points to the proxy, with a job token for that one job and one user.

- The proxy checks the job token, adds the user's real token, and sends the request on to the MCP server.
- It refuses a job token after the job ends, and for a server that the job did not get.
- Do not put your app's session check in front of it. Each of its answers has the header `x-byoa-proxy: 1`.
- No real MCP token is in the sandbox's environment, files or processes at any time. A test checks this after each job with a real MCP call ([V5](../SPEC.md#verification)).

The same proxy is also the relay of a job on the user's OpenCode Go key (beta), at `<proxyUrl>/_plan/opencode-go/…`: it checks the job token, adds the user's key, and sends only the model requests on to OpenCode. So do not filter the paths below `proxyUrl`. See [Supported AI subscriptions](subscriptions.md#opencode-go-through-a-key-beta).

A job gets only the servers that your app names in its `mcp`. A server in `mcp` that the user has not connected gives an `error` event with code `mcp`, and the job runs without it.

## When the proxy is down

Before the harness starts, byoa checks from the job's sandbox that each MCP server of the job answers through `agents.proxy`. When the sandbox cannot reach the proxy (a wrong `proxyUrl`, a tunnel that ended, a firewall), the job does not start: `run` gives an `error` event with code `mcp` and ends with `ok: false`, and `session` throws `ProxyError`. A server that does not answer gives an `error` event with code `mcp`, and the job runs. Without this check, a harness that cannot reach a server leaves its tools out and still ends well.

## Your app's own tools

Give your app's own tools to `createAgents` as functions (`tools`): MCP server name → tool name → `{ description, input, run }`. `input` is the JSON Schema of the arguments. A job gets them by the server's name in `mcp`, as it gets a connected server. The harness calls them through `agents.proxy`, which checks the job token and calls `run(args, { user, job })` in your backend, for the user of that job. So you write no MCP server, keep no token for it, and connect nothing for each user. What `run` returns goes to the agent (a string as it is, other values as JSON); when it throws, the agent gets the message as a failed call. byoa does not check the arguments against `input`: check them in `run`.

```ts
const agents = createAgents({
  ...options,
  tools: {
    todos: {
      add_todo: {
        description: 'Add one to-do.',
        input: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        run: ({ title }, { user }) => db.addTodo(user, String(title)),
      },
      list_todos: { description: "List the user's to-dos.", run: (_args, { user }) => db.todos(user) },
    },
  },
})
agents.run(userId, { harness: 'codex', task, mcp: ['todos'] })
```

## Move a grant into byoa

To move an MCP grant that the user already made elsewhere into byoa, call `agents.importMcp(userId, { name, url, oauth })` with the MCP SDK's state (`client`, `tokens`, `at`). Delete the old copy, so that the grant keeps one refresh owner.

## Call a service's other API with the user's grant

Some MCP servers have an API next to the MCP endpoint that is not MCP, such as an export. Your backend calls it with the user's grant through `agents.fetchWithGrant(userId, 'tasks', 'https://mcp.example.com/export')`: byoa adds the current token, refreshed by the one refresh owner, and gives you the response. By default, it sends the token only to the origin of that grant's MCP server. It does not follow redirects, and never gives you the token.

When the service's API is on another origin than its MCP server, name that origin in your own configuration, for the MCP server's origin. Only grants of that MCP server can go there, and only to that exact origin:

```ts
const agents = createAgents({
  ...options,
  // Margins' MCP server is on margin.rippling.computer; its export is on its Convex site
  grantOrigins: { 'https://margin.rippling.computer': ['https://helpful-tern-930.convex.site'] },
})
const r = await agents.fetchWithGrant(userId, 'margins', 'https://helpful-tern-930.convex.site/ext/export')
```

The MCP server, the sandbox and the user cannot add an origin. Each one is an exact origin: https, no path, no wildcard.
