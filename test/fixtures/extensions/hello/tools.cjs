'use strict';

module.exports = (h) => ({
  tools: [
    {
      name: 'hello_count',
      description: 'Counts the turns the hello extension saw end since it was loaded.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => h.httpRequest('GET', '/api/hello/count'),
    },
  ],
});
