export interface McpFixture {
  readonly servers: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export const PINNED_CHILD_FIXTURE: McpFixture = {
  servers: {
    fix: {
      tools: [
        {
          name: "echo",
          description: "Echo text back.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
        {
          name: "search_docs",
          description: "Search the docs.",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
        },
        {
          name: "Weird-Name!",
          description: "Sanitization probe.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    },
  },
};

export const PINNED_COLLISION_FIXTURE: McpFixture = {
  servers: {
    fix: {
      tools: [
        {
          name: "Do-Thing",
          description: "first",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "do thing",
          description: "second, same slug",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "other",
          description: "distinct",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    },
  },
};

export const CROSS_SERVER_FIXTURE: McpFixture = {
  servers: {
    "github.com": {
      tools: [
        {
          name: "search",
          description: "from A",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
    },
    github_com: {
      tools: [
        {
          name: "search",
          description: "from B",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
    },
  },
};

export const ONE_SERVER = { mcpServers: { fix: { command: "/bin/echo" } } } as const;

export function oneToolFixture(overrides: Readonly<Record<string, unknown>> = {}): McpFixture {
  return {
    servers: {
      fix: {
        tools: [
          {
            name: "echo",
            description: "d",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          },
        ],
        ...overrides,
      },
    },
  };
}
