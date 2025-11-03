import { createProblem } from '../utils/problem.js';

export function notFoundHandler(_req, _res, next) {
  next(
    createProblem({
      type: 'https://httpstatuses.com/404',
      title: 'Not Found',
      status: 404,
      detail: 'The requested resource could not be found.',
    })
  );
}
