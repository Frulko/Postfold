import type { Mailbox } from '../shared/mailbox.js'

// Données fictives uniquement, sans connexion IMAP ni SMTP.
export const demoMailbox: Mailbox = {
  projects: [
    { id: '1842', name: 'Résidence Bellevue', color: 'green', createdAt: '2026-07-01T09:00:00Z' },
    { id: '2056', name: 'Atelier des Quais', color: 'orange', createdAt: '2026-08-15T09:00:00Z' },
    { id: '2170', name: 'Maison des Arts', color: 'blue', createdAt: '2026-09-20T09:00:00Z' },
  ],
  contacts: [
    { id: 'paul', name: 'Paul Martin', email: 'paul.martin@example.test', company: 'Atelier Martin', phone: '+33 1 00 00 00 01' },
    { id: 'claire', name: 'Claire Dubois', email: 'claire.dubois@example.test', company: 'Les Quais', phone: '+33 1 00 00 00 02' },
    { id: 'lea', name: 'Léa Bernard', email: 'lea.bernard@example.test', company: 'Maison des Arts', phone: '+33 1 00 00 00 03' },
  ],
  conversations: [
    { id: 'plans', projectId: '1842', contactId: 'paul', subject: 'Les plans de la résidence',
      preview: 'Pouvez-vous nous transmettre les derniers plans mis à jour ?',
      body: 'Bonjour,\n\nNous préparons notre prochaine réunion de chantier. Pourriez-vous nous transmettre les derniers plans mis à jour de la résidence Bellevue ?\n\nNous souhaitons notamment vérifier les accès et les dimensions du hall avant de valider la suite.\n\nMerci pour votre aide,\nPaul',
      time: '10:42', status: 'open', assignee: null, unread: true },
    { id: 'delivery', projectId: '1842', contactId: 'paul', subject: 'Confirmation de la livraison',
      preview: 'Merci pour votre retour, nous attendons la confirmation du transporteur.',
      body: 'Bonjour,\n\nMerci pour votre retour. Nous attendons la confirmation du transporteur pour fixer le créneau de livraison.\n\nBien à vous,\nPaul',
      time: '09:18', status: 'waiting', assignee: 'Julie', unread: false },
    { id: 'quote', projectId: '2056', contactId: 'claire', subject: 'Une précision sur le devis',
      preview: 'J’aurais une question concernant la dernière ligne du devis.',
      body: 'Bonjour,\n\nJ’aurais une question concernant la dernière ligne du devis. Est-ce que la pose est incluse dans le montant indiqué ?\n\nMerci,\nClaire',
      time: 'Hier', status: 'open', assignee: 'Marc', unread: true },
    { id: 'meeting', projectId: '2170', contactId: 'lea', subject: 'Compte rendu de notre réunion',
      preview: 'Tout est validé pour la prochaine étape. Merci à toute l’équipe !',
      body: 'Bonjour,\n\nTout est validé pour la prochaine étape. Merci à toute l’équipe pour la qualité des échanges !\n\nÀ bientôt,\nLéa',
      time: 'Lundi', status: 'closed', assignee: 'Julie', unread: false },
  ],
}
