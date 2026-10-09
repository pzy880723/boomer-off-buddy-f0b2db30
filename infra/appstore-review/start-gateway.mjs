import { createReviewGateway } from './gateway.mjs';
const gateway = createReviewGateway({ productionOrigin: process.env.ERP_PRODUCTION_ORIGIN,
  reviewOrigin: process.env.ERP_REVIEW_ORIGIN, reviewEmail: process.env.ERP_REVIEW_EMAIL });
gateway.listen(Number(process.env.PORT ?? 3007), '127.0.0.1', () => {
  console.log(JSON.stringify({ listening: true, port: gateway.address().port }));
});
