export default {
  routes: [
    {
      method: 'GET',
      path: '/firstblogs/:slug/related',
      handler: 'firstblog.related',
      config: {
        auth: false
      }
    }
  ]
};
