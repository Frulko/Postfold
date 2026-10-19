# GitLab CI et Portainer Swarm

La CI reprend les templates `myrole/ci-templates@v1`, comme les autres projets MyRole : **build → deploy**. Un push ou un lancement manuel sur la branche par défaut construit le `Dockerfile`, publie `registry.myrole.app/myrole/postfold:latest` et `:sha-<CI_COMMIT_SHORT_SHA>`, puis appelle le webhook Portainer s'il est configuré. Seule la production est gérée. La compilation se fait dans l'image ; il n'y a pas de job de tests GitLab séparé.

Le runner et l'utilisateur qui lance la pipeline doivent avoir accès aux templates. L'authentification au registre pendant le build utilise les variables prédéfinies GitLab. Les réglages BuildKit déjà hérités du groupe MyRole restent utilisables.

## Variables GitLab

Dans **Settings → CI/CD → Variables** :

| Variable | Valeur |
| --- | --- |
| `PORTAINER_WEBHOOK_URL` | Webhook de mise à jour de la stack de production. Sans cette variable, la CI publie seulement l'image. |
| `PORTAINER_WEBHOOK_SECRET` | Facultatif : secret envoyé dans `x-webhook-secret`, seulement si ton endpoint le demande. |

Masquer les valeurs et les protéger avec la branche de production. Les variables applicatives ci-dessous vont dans **Portainer**, pas dans GitLab.

## Stack Portainer

Utiliser [`docker-compose.portainer.yml`](../docker-compose.portainer.yml) sur l'environnement **Docker Swarm**, avec une stack nommée `postfold`. Les trois services utilisent le réseau overlay créé par Swarm. L'API et PostgreSQL ne publient aucun port ; le web publie **3002** en ingress. Le reverse proxy HTTPS cible **HTTP, adresse d'un nœud Swarm, port 3002**, en conservant le header `Origin`.

Ajouter `registry.myrole.app` aux registres Portainer avec un deploy token GitLab ayant `read_registry`, et sélectionner ce registre pour la stack. Les images sont écrites directement dans le Compose, comme les autres stacks MyRole. Le premier build GitLab doit avoir publié `latest` avant le déploiement.

Dans **Environment variables**, renseigner :

```dotenv
POSTGRES_PASSWORD=REMPLACER_PAR_UN_MOT_DE_PASSE_HEXADECIMAL
POSTFOLD_ORIGIN=https://postfold.myrole.app
KEYCLOAK_ISSUER=https://TON_KEYCLOAK/realms/TON_REALM
```

`POSTFOLD_ORIGIN` est l'origine publique exacte, sans chemin ni slash final. `KEYCLOAK_ISSUER` est l'URL HTTPS du realm, sans suffixe `/.well-known/openid-configuration`. Générer le mot de passe PostgreSQL avec `openssl rand -hex 32` : l'hexadécimal peut être inséré directement dans l'URL de connexion.

Les autres variables ont déjà leurs valeurs par défaut ; ne les ajouter que pour les modifier :

| Variable | Défaut | Usage |
| --- | --- | --- |
| `KEYCLOAK_CLIENT_ID` | `postfold` | Client OIDC confidentiel. |
| `KEYCLOAK_REQUIRED_ROLE` | `support` | Rôle **du client** nécessaire pour se connecter. |
| `KEYCLOAK_ADMIN_ROLE` | `support-admin` | Rôle du client pour administrer Postfold. |
| `MAILBOX_ID` | `support` | Identifiant stable de la boîte partagée. |
| `MAILBOX_KEY_ID` | `v1` | Version de la clé de chiffrement, à conserver avec les sauvegardes. |
| `MAILBOX_SYNC_LIMIT` | `200` | Nouveaux messages importés par dossier et par cycle, de 1 à 1000. |
| `MAILBOX_MODE` | `imap` | Mettre temporairement `demo` pour le premier import décrit ci-dessous. |

La stack impose `POSTFOLD_AUTH=keycloak` et `DEMO_MODE=false`. `DATABASE_URL`, les chemins des secrets et l'adresse interne de l'API sont déjà configurés.

## Deux secrets Docker à créer une seule fois

Dans **Portainer → Secrets**, créer :

| Nom exact | Contenu |
| --- | --- |
| `postfold_mailbox_key` | Une clé générée avec `openssl rand -hex 32` : 64 caractères hexadécimaux. Réutiliser la clé existante si tu migres une installation. |
| `postfold_keycloak_client_secret` | Le secret du client Keycloak `postfold`, onglet Credentials. |

Le Compose monte ces [secrets Swarm](https://docs.docker.com/engine/swarm/secrets/) uniquement dans l'API, sous forme de fichiers privés lisibles par son utilisateur UID 1000. L'application exige ces fichiers ; des variables `MAILBOX_KEY` ou `KEYCLOAK_CLIENT_SECRET` ne sont pas prises en charge. Conserver une copie sécurisée de la clé : elle chiffre les identifiants mail et les sessions et ne doit pas être régénérée à chaque déploiement.

Configurer le client Keycloak selon [le guide SSO](keycloak.md#1-create-the-keycloak-client), avec :

- Client authentication et Standard flow activés, PKCE `S256`.
- Redirect URI : `https://postfold.myrole.app/auth/callback`.
- Post logout redirect URI : `https://postfold.myrole.app/auth/logged-out`.
- Web origin : `https://postfold.myrole.app`.
- Rôle client `support` attribué aux utilisateurs ; ajouter aussi `support-admin` aux administrateurs.
- Mapper d'audience incluant `postfold` dans l'access token, scopes `basic`, `profile`, `email`, `roles`.

Adapter le domaine et le client à tes valeurs. Keycloak doit être joignable depuis les navigateurs et depuis l'API.

## Premier démarrage et import de la boîte mail

L'API en mode `imap` attend une boîte déjà enregistrée en base. Pour une installation neuve :

1. Ajouter temporairement **`MAILBOX_MODE=demo`** dans Portainer et déployer la stack. `DEMO_MODE` reste `false` : seuls les endpoints de santé et d'authentification sont démarrés, sans données de démonstration. L'interface mail n'est pas encore utilisable.
2. Dans **Containers**, ouvrir le conteneur **Running** du service `postfold_api`, puis **Console**. Choisir `/bin/sh`, utilisateur `node` (UID 1000), puis **Connect**. La console du conteneur utilise déjà les variables et secrets de l'API ; aucune connexion SSH n'est nécessaire. Voir [la documentation Portainer](https://docs.portainer.io/2.27/user/docker/containers/console).
3. Exécuter d'abord `unset HISTFILE`, puis coller la commande ci-dessous en remplaçant les valeurs du fournisseur. Le délimiteur `'POSTFOLD_MAILBOX_JSON'` empêche le shell d'interpréter les caractères `$` des mots de passe. Respecter la syntaxe JSON : un guillemet dans une valeur s'écrit `\"`, un antislash `\\`.

```sh
node /app/api/dist/api/configure-mailbox.js <<'POSTFOLD_MAILBOX_JSON'
{
  "account": {
    "email": "support@example.com",
    "name": "Support",
    "imap": {
      "host": "imap.example.com",
      "port": 993,
      "security": "tls",
      "user": "support@example.com",
      "password": "REPLACE_WITH_IMAP_APP_PASSWORD"
    },
    "smtp": {
      "host": "smtp.example.com",
      "port": 465,
      "security": "tls",
      "user": "support@example.com",
      "password": "REPLACE_WITH_SMTP_APP_PASSWORD"
    },
    "sentPath": "Sent",
    "saveSent": true
  }
}
POSTFOLD_MAILBOX_JSON
```

Pour SMTP sur le port 587, utiliser `"security": "starttls"`. Adapter `sentPath` au dossier Envoyés réel et mettre `saveSent` à `false` si le fournisseur conserve déjà les messages envoyés. Ne pas ajouter le bloc `access`, réservé au mode Basic. Le JSON est transmis directement au programme, sans fichier à créer dans le conteneur.

4. Attendre le message **`Encrypted mailbox account saved`**. Cette commande valide le format et chiffre les identifiants dans PostgreSQL ; elle ne teste pas la connexion au fournisseur. En cas d'erreur, rester dans ce mode et corriger la configuration avant de poursuivre.
5. Fermer la console. Dans les variables **de la stack**, remettre **`MAILBOX_MODE=imap`**, puis **Update the stack**. Garder le même `MAILBOX_ID`, la même clé et `MAILBOX_KEY_ID`.
6. Vérifier que l'API reste démarrée, se connecter via Keycloak, relever la boîte et envoyer une réponse de test. Ce sont ces opérations qui confirment l'accès IMAP/SMTP. L'import ne sera pas nécessaire aux prochains déploiements tant que la base et la clé sont conservées.

Swarm démarre les services sans attendre leurs dépendances. Si PostgreSQL n'est pas encore prêt, l'API est relancée par sa politique de redémarrage. Un seul réplica API reste actif, avec remplacement `stop-first`, pour éviter deux workers IMAP simultanés.

## Mises à jour

Activer le webhook de la stack, configurer la récupération de la nouvelle image lors de sa mise à jour, puis mettre son URL dans `PORTAINER_WEBHOOK_URL` sur GitLab. Chaque pipeline réussie sur la branche par défaut publie `latest` puis demande le redéploiement. Le premier déploiement de la stack reste à faire dans Portainer.

Conserver le nom de stack, le volume `postfold_postfold-postgres`, le mot de passe PostgreSQL et les secrets. La stack n'impose aucune contrainte de placement ; le volume PostgreSQL est local au nœud qui l'héberge et n'est pas transféré par Swarm si la tâche change de nœud. Sauvegarder la base et la clé avant une mise à jour, selon [la procédure de sauvegarde](docker.md#update-without-losing-shared-data), en utilisant les conteneurs de la stack via Portainer ou `docker exec`.

Pour revenir à une image précédente, remplacer **les deux** références `:latest` du Compose par `:sha-<CI_COMMIT_SHORT_SHA>` et mettre à jour la stack. Cela ne restaure pas la base : une modification de schéma incompatible nécessite la sauvegarde correspondante.
