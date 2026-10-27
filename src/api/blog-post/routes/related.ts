export default {
  routes: [
    {
      method: 'GET',
      path: '/blog-posts/:slug/related',
      handler: 'blog-post.related',
      config: {
        auth: false
      }
    }
  ]
};
