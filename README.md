# Anthony Panizza DIAPO

Vote en direct par QR code. Pages : `/screen` (projection), `/admin` (contrôle), `/vote` (téléphones).

## Mise en ligne (Render)
1. Créez un dépôt GitHub avec ce dossier (`node_modules` et `data.json` ignorés via `.gitignore`).
2. Sur render.com : New > Blueprint (ou Web Service) > choisissez le dépôt. Définissez `ADMIN_KEY` (mot de passe admin).
3. Vous obtenez `https://anthony-panizza-diapo.onrender.com`. Le QR code s'adapte automatiquement.

## Domaine anthony-panizza-diapo.fr
(`_` est interdit dans un nom de domaine : utilisez des tirets.)
1. Achetez le domaine (OVH, Gandi, Namecheap…).
2. Render > votre service > Settings > Custom Domains > ajoutez `anthony-panizza-diapo.fr` et `www.anthony-panizza-diapo.fr`.
3. Chez le registrar, ajoutez les enregistrements DNS indiqués par Render (CNAME pour `www`, A/ALIAS pour la racine).
4. Attendez la propagation (quelques minutes à quelques heures) : HTTPS est automatique.

Note : l'offre gratuite de Render s'endort après inactivité (premier chargement lent) et perd `data.json` à chaque redéploiement ; ouvrez le site avant votre présentation.
