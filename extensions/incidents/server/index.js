/*
 * The incident.io extension's lifecycle (cf. server/extensions.js). Nothing runs in the background: the
 * incident.io process starts with the first read. The page exists only where the incident.io
 * desktop app is installed, as in the desktop app.
 */
import { closeIncidents } from './incidents.js';
import { findIncidentBin } from './client.js';

export default {
  stop() { closeIncidents(); },
  available() { return !!findIncidentBin(); },
};
