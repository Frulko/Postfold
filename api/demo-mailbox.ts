import type { Mailbox } from '../shared/mailbox.js'

// Fictional IT support requests; no IMAP or SMTP connection.
export const demoMailbox: Mailbox = {
  projects: [
    { id: '1842', name: 'Access & identity', color: 'blue', createdAt: '2026-07-01T09:00:00Z' },
    { id: '2056', name: 'Employee onboarding', color: 'purple', createdAt: '2026-08-15T09:00:00Z' },
    { id: '2170', name: 'Backups', color: 'green', createdAt: '2026-09-20T09:00:00Z' },
    { id: 'f_vpn', name: 'VPN', parentId: '1842', color: 'blue', createdAt: '2026-09-21T09:00:00Z' },
  ],
  labels: [{ id: 'urgent', name: 'Urgent', color: 'rose' }, { id: 'security', name: 'Security', color: 'orange' }],
  contacts: [
    { id: 'paul', name: 'Paul Martin', email: 'paul.martin@example.test', company: 'Northstar · Engineering', phone: '+33 1 00 00 00 01' },
    { id: 'claire', name: 'Claire Dubois', email: 'claire.dubois@example.test', company: 'Northstar · People Ops', phone: '+33 1 00 00 00 02' },
    { id: 'lea', name: 'Léa Bernard', email: 'lea.bernard@example.test', company: 'Northstar · Platform', phone: '+33 1 00 00 00 03' },
  ],
  conversations: [
    { id: 'plans', threadId: 'plans', sentAt: '2026-10-06T10:42:00+02:00', projectId: '1842', contactId: 'paul', subject: 'VPN connection fails after the update',
      preview: 'The VPN disconnects during sign-in. Could you check my access?',
      body: 'Hi team,\n\nSince this morning’s laptop update, the VPN disconnects right after sign-in. I can access my email, but our internal tools are unreachable.\n\nI have restarted the client and tried a different network. The client shows error AUTH-403. Could you check whether my access is still active?\n\nI’m available for a quick troubleshooting call.\n\nThanks,\nPaul',
      time: '10:42', status: 'open', assignee: null, unread: true, labelIds: ['urgent'] },
    { id: 'vpn-reply', threadId: 'plans', sentAt: '2026-10-06T10:50:00+02:00', projectId: '1842', contactId: 'paul',
      sender: { name: 'Julie Dumoulin', email: 'support@example.test' }, subject: 'Re: VPN connection fails after the update',
      preview: 'Your access is active. Please update the VPN client to version 5.2.',
      body: 'Hi Paul,\n\nYour access is active. The laptop update requires VPN client version 5.2. Please install the update from the company software portal and retry.\n\nIf the issue persists, send us the new error code.\n\nThanks,\nJulie',
      time: '10:50', status: 'open', assignee: 'Julie', unread: false },
    { id: 'vpn-followup', threadId: 'plans', sentAt: '2026-10-06T11:03:00+02:00', projectId: '1842', contactId: 'paul',
      subject: 'Re: VPN connection fails after the update', preview: 'The updated client connects now. Could you check access to the staging server?',
      body: 'Hi Julie,\n\nThe updated client connects now — thanks! I can reach most internal tools again. Could you check access to the staging server as well?\n\nThanks,\nPaul',
      time: '11:03', status: 'open', assignee: 'Julie', unread: true, labelIds: ['urgent'] },
    { id: 'delivery', sentAt: '2026-10-06T09:18:00+02:00', projectId: '1842', contactId: 'paul', subject: 'MFA reset for my replacement phone',
      preview: 'My replacement phone is ready. Waiting for the identity check.',
      body: 'Hi Julie,\n\nMy replacement phone is ready, but the authenticator app no longer has my work account.\n\nI’ve completed the identity verification form. Please let me know when the MFA reset can proceed.\n\nThanks,\nPaul',
      time: '09:18', status: 'waiting', assignee: 'Julie', unread: false, labelIds: ['security'] },
    { id: 'quote', sentAt: '2026-10-05T15:00:00+02:00', projectId: '2056', contactId: 'claire', subject: 'New starter: laptop and workspace access',
      preview: 'A new engineer starts Monday. Can we prepare their laptop and accounts?',
      body: 'Hi IT team,\n\nA new engineer joins on Monday. Could you prepare a laptop, email account and access to the engineering workspace?\n\nThe manager has approved the standard access profile. Please confirm when the equipment is ready for collection.\n\nThanks,\nClaire',
      time: 'Hier', status: 'open', assignee: 'Marc', unread: true },
    { id: 'meeting', sentAt: '2026-10-05T09:00:00+02:00', projectId: '2170', contactId: 'lea', subject: 'Backup recovery test completed',
      preview: 'The restore test passed. Recovery notes are ready for the runbook.',
      body: 'Hi team,\n\nThe scheduled backup recovery test passed this morning. We restored the staging database and verified application access.\n\nThe recovery notes are ready for the runbook. Thanks for coordinating the maintenance window!\n\nBest,\nLéa',
      time: 'Lundi', status: 'closed', assignee: 'Julie', unread: false },
  ],
}
