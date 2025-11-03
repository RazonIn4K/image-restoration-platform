import { getClients } from '../context/clients.js';

export function attachClients() {
  return (req, _res, next) => {
    req.clients = getClients();
    next();
  };
}
