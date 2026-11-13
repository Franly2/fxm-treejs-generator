export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const isMock = process.env.ANTHROPIC_API_KEY === 'mock';

  return new Response(
    JSON.stringify({
      hasKey,
      mock: isMock,
      models: [
        { id: 'opus', label: 'Opus 5.5', roles: ['plan'] },
        { id: 'sonnet', label: 'Sonnet 5.5', roles: ['plan', 'execute'] },
        { id: 'haiku', label: 'Haiku 5.5', roles: ['execute'] },
      ],
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
}
