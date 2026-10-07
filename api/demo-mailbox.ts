import type { Conversation, Mailbox } from '../shared/mailbox.js'

export const demoMembers = [
  { id: 'demo-julie', name: 'Julie Dumoulin', email: 'julie@example.test', provider: 'demo' as const },
  { id: 'demo-marc', name: 'Marc Laurent', email: 'marc@example.test', provider: 'demo' as const },
  { id: 'demo-emma', name: 'Emma Moreau', email: 'emma@example.test', provider: 'demo' as const },
]

const demoContacts = [
  { id: 'paul', name: 'Paul Martin', email: 'paul.martin@example.test', company: 'Northstar · Engineering', phone: '+33 1 00 00 00 01' },
  { id: 'claire', name: 'Claire Dubois', email: 'claire.dubois@example.test', company: 'Northstar · People Ops', phone: '+33 1 00 00 00 02' },
  { id: 'lea', name: 'Léa Bernard', email: 'lea.bernard@example.test', company: 'Northstar · Platform', phone: '+33 1 00 00 00 03' },
]

const demoThreads = [
  { id: 'incident-rollout', projectId: '1842', subject: 'SSO rollout: intermittent access to internal tools', contacts: ['paul', 'claire', 'lea'], replies: [
    ['paul', '08:05', 'Several engineers cannot open the internal dashboard after this morning’s SSO rollout. Sign-in succeeds, then the browser returns to the login screen.\n\nIt affects the staging dashboard and the time-tracking application. Production deployments are paused until access is restored.'],
    ['demo-julie', '08:12', 'Thanks for the report. I am coordinating this incident with Platform.\n\nPlease share the affected application, browser version and time of the last failed sign-in. Avoid sending passwords, tokens or complete session cookies.'],
    ['claire', '08:20', 'People Ops is affected too. Three new starters can sign in to email, but not to the onboarding portal.\n\nI have added Léa from Platform to this thread so we can track both teams together.'],
    ['lea', '08:28', 'I can reproduce it on the staging dashboard. The identity provider accepts the request, but the application rejects the callback.\n\nI will compare the proxy configuration with yesterday’s working version.'],
    ['demo-marc', '08:36', 'The workstation checks are complete: the issue reproduces in two browsers and on two networks.\n\nClearing the browser cache did not resolve it. We should keep the investigation on the application side.'],
    ['paul', '08:44', 'Here are the affected applications:\n\n• staging-dashboard.example.test\n• timesheets.example.test\n\nMy last failed sign-in was at 08:41. A colleague already signed in before the rollout can still use both tools.'],
    ['lea', '08:52', 'The new proxy configuration forwards an incorrect public origin for two applications. Their redirect addresses no longer match the client configuration.\n\nI am preparing a small correction and testing it on staging before changing the remaining applications.'],
    ['demo-julie', '09:00', 'Incident summary:\n\nImpact: new sessions fail on the dashboard, time tracking and onboarding portal. Existing sessions remain usable.\nOwner: Platform for the proxy change; Support for user validation.\nNext update: after the staging test.\n\nPlease keep each application’s test result in this thread so the next teammate can follow the investigation.'],
    ['claire', '09:08', 'I have informed the affected starters and their managers. We have postponed account validation until the next update.\n\nNo one needs a password reset. I will test the onboarding portal when the correction is ready.'],
    ['lea', '09:16', 'The staging correction is deployed. A new session now reaches the dashboard successfully.\n\nPaul, could you test with your regular account? Please verify the dashboard home page and an engineering project, then sign out and back in once.'],
    ['paul', '09:24', 'Dashboard validation passed. I can open the engineering project and start a new session after signing out.\n\nTime tracking still loops at sign-in, so please keep the incident open for that application.'],
    ['demo-marc', '09:32', 'Confirmed from a second workstation: dashboard access is restored, time tracking still fails.\n\nI have recorded the test results in the incident notes and will check a fresh onboarding account next.'],
    ['lea', '09:40', 'The same correction is now applied to time tracking and onboarding.\n\nVerification checklist:\n1. Open a fresh browser session.\n2. Sign in using the normal SSO flow.\n3. Open the application’s home page.\n4. Check the expected workspace.\n5. Sign out and confirm a new session works.\n\nI am monitoring callback failures while you run these checks.'],
    ['claire', '09:48', 'The onboarding portal works again for all three starters. Their expected workspaces are visible and a second sign-in succeeds.\n\nThanks for keeping the updates in one place — the managers can follow the recovery without opening separate tickets.'],
    ['paul', '09:56', 'Time tracking validation passed too. The engineering team can use all affected applications again.\n\nCan we add the proxy origin check to the rollout checklist before the next deployment?'],
    ['demo-julie', '10:04', 'User validation is complete for Engineering and People Ops. The remaining work is the rollout checklist and the monitoring review.\n\nLéa owns the checklist update; I will send the final incident summary after the monitoring window.'],
    ['lea', '10:12', 'The rollout checklist now includes the public origin, allowed redirect addresses and a fresh-session test for every application.\n\nMonitoring has shown no new callback failures since the correction. I have linked the review notes to the Platform runbook.'],
    ['paul', '10:20', 'Final check from Engineering: access is stable, including after restarting the browser.\n\nPlease share the final incident summary with Claire and me. We can resume the postponed validation and deployment work.'],
  ] },
  { id: 'onboarding-batch', projectId: '2056', subject: 'New starters: equipment, accounts and first-day checks', contacts: ['claire', 'paul'], replies: [
    ['claire', '08:10', 'Four engineers join next Monday. Can we prepare their laptops, email accounts and engineering workspace access?\n\nThe managers have approved the standard access profile. Two colleagues work remotely and need their equipment delivered before Friday.'],
    ['demo-marc', '08:22', 'I have reserved four laptops and opened the preparation checklist.\n\nPlease confirm the remote delivery addresses through the protected HR form. We will keep personal addresses out of this shared thread.'],
    ['paul', '08:34', 'The engineering workspace and repository groups are confirmed. The new starters need the standard contributor profile.\n\nNo production administrator access is required. I can join the first-day validation call.'],
    ['claire', '08:46', 'The protected delivery forms are complete. The two office-based colleagues will collect their laptops from reception on Monday morning.\n\nCould you confirm whether the remote devices will arrive in time?'],
    ['demo-marc', '08:58', 'All four devices are enrolled. The remote shipments are booked for Thursday delivery.\n\nEmail and SSO accounts are ready; the first sign-in will require setting up MFA.'],
    ['demo-julie', '09:10', 'Support will cover the first-day sign-in and MFA setup.\n\nWe will validate email, the engineering workspace and the VPN separately, then record any issue against the affected starter.'],
    ['paul', '09:22', 'I have checked the workspace membership against the approved profile. The repository groups are correct.\n\nPlease include the development environment guide in the welcome message.'],
    ['demo-marc', '09:34', 'Preparation checklist:\n\n• Device enrolled and updated.\n• Recovery information stored in the approved system.\n• Email and SSO account created.\n• Engineering workspace membership checked.\n• VPN client installed.\n• Welcome guide included.\n\nThe delivery tracking is available in the protected HR record.'],
    ['claire', '09:46', 'Both remote colleagues have confirmed their delivery availability. Reception has the collection instructions for Monday.\n\nPlease send the final readiness confirmation to Paul and me.'],
    ['demo-julie', '09:58', 'Everything is ready for Monday. Marc owns equipment collection, I own sign-in support and Paul owns the workspace checks.\n\nWe will keep this thread open until the four first-day validations are complete.'],
  ] },
]

const longConversations: Conversation[] = demoThreads.flatMap((thread) => thread.replies.map(([author, time, body], index) => {
  const contact = demoContacts.find((person) => person.id === author)
  const member = demoMembers.find((person) => person.id === author)
  return { id: index === 0 ? thread.id : `${thread.id}-${index}`, threadId: thread.id, projectId: thread.projectId,
    contactId: contact?.id ?? thread.contacts[0], sender: { name: contact?.name ?? member!.name, email: contact?.email ?? 'support@example.test' },
    participants: demoContacts.filter((person) => thread.contacts.includes(person.id)).map(({ name, email }) => ({ name, email })),
    subject: index === 0 ? thread.subject : `Re: ${thread.subject}`, body, preview: body.replace(/\s+/g, ' ').slice(0, 160),
    sentAt: `2026-10-07T${time}:00+02:00`, time, status: 'open', assignee: null, outgoing: !!member,
    unread: !!contact && index === thread.replies.length - 1, labelIds: thread.id === 'incident-rollout' ? ['urgent'] : [],
  }
}))

// Fictional IT support requests; no IMAP or SMTP connection.
export const demoMailbox: Mailbox = {
  projects: [
    { id: '1842', name: 'Access & identity', color: 'blue', createdAt: '2026-07-01T09:00:00Z' },
    { id: '2056', name: 'Employee onboarding', color: 'purple', createdAt: '2026-08-15T09:00:00Z' },
    { id: '2170', name: 'Backups', color: 'green', createdAt: '2026-09-20T09:00:00Z' },
    { id: 'f_vpn', name: 'VPN', parentId: '1842', color: 'blue', createdAt: '2026-09-21T09:00:00Z' },
  ],
  labels: [{ id: 'urgent', name: 'Urgent', color: 'rose' }, { id: 'security', name: 'Security', color: 'orange' }],
  contacts: demoContacts,
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
    ...longConversations,
  ],
}
