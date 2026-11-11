# Calque

Documents de conduite du chef de section : carte, plan horaire, tableau des moyens et liste de section. App web autonome : tout reste sur le téléphone et se partage par QR code ou en PDF, sans serveur.

Carte : signes du règlement 52.003 « Signes conventionnels » (Armée suisse) redessinés en SVG, et MIL-STD-2525C (milsymbol). Armes, matériel, postes et obstacles orientables (‰).

Itinéraires : calcul selon les moyens engagés (poids, largeur, roues ou chenilles) sur le réseau swissTLM3D, avec les itinéraires de déplacement des chars publiés (VBS). Servitudes probables seulement : ponts, hauteurs, autorisations et carte approuvée du bureau des déplacements des chars restent à confirmer.

Plan horaire : journée plein écran avec date, activités, servitudes et délais. Import du Picasso (programme de travail) depuis une photo, un PDF ou le fichier Excel : cadrage de la grille, choix de sa colonne, lecture des activités et des servitudes, vérification avant ajout. La lecture du texte se fait sur l'appareil (Tesseract) ; l'extrait d'origine reste affiché à côté de chaque activité.

Tableau des moyens : véhicules avec silhouette, nom du poste, plaque, réseaux radio, équipage tiré de la liste de section, carburant, état et remarques.

Liste de section : officiers, sous-officiers et militaires de troupe ; import depuis Excel, CSV, photo d'une liste ou texte collé.

Export : KMZ, GeoJSON, GPX pour la carte ; PDF pour le plan horaire, le tableau des moyens et la liste de section. Tout est créé sur l'appareil.

Carte et données © swisstopo, VBS (geo.admin.ch) · milsymbol (MIT) · Leaflet (BSD-2) · jsQR (Apache-2.0) · qrcode-generator (MIT) · Tesseract.js (Apache-2.0) · PDF.js (Apache-2.0) · Inter (OFL)
