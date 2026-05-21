// Minimal fixture plugin entry — does NOT import the SDK so it stays
// independent of the host's path resolution. The plugin loader can read
// the manifest and (if it dynamic-imports the entry) call any of the
// named exports below.

export const tools = [
  {
    def: {
      name: 'hello',
      description: 'Return a greeting.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    async execute() {
      return { success: true, output: 'hello from fixture plugin' };
    },
  },
];

export const commands = [
  {
    def: {
      name: 'hello',
      description: 'Print a friendly greeting.',
      args: '',
    },
    async execute(_args, ctx) {
      ctx.print('hello from fixture plugin');
    },
  },
];
