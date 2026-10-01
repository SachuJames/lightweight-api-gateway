export default {
  name: 'fixture-add-header',
  version: '0.0.1',
  onRequest: async (req) => {
    req.headers['x-fixture'] = 'yes';
  },
};
