const express = require('express');
const path = require('path');
const fs = require('fs');
const { BlobServiceClient } = require('@azure/storage-blob');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== CONFIGURACIÓN SEGURA =====
app.get('/api/config', (req, res) => {
    try {
        let cfg = {};
        const configPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configPath)) {
            cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }

        const config = {
            clientId: process.env.AZURE_CLIENT_ID || cfg.clientId,
            tenantId: process.env.AZURE_TENANT_ID || cfg.tenantId,
            adminUsers: process.env.ADMIN_USERS
                ? process.env.ADMIN_USERS.split(',').map(s => s.trim()).filter(Boolean)
                : (cfg.adminUsers || []),
            restrictByResponsable: cfg.restrictByResponsable !== false
        };
        res.json(config);
    } catch (e) {
        console.error('Error leyendo configuración:', e);
        res.status(500).json({ error: 'Error de configuración' });
    }
});

// ===== ALMACENAMIENTO EN AZURE BLOB =====
const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = 'app-data';
const blobName = 'ssl-data.json'; // Nombre específico para este gestor

let blockBlobClient;

if (connectionString) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(containerName);
    blockBlobClient = containerClient.getBlockBlobClient(blobName);
}

const defaultData = {
    aplicaciones: [],
    certificados: []
};

async function streamToString(readableStream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on('data', (data) => chunks.push(data.toString()));
        readableStream.on('end', () => resolve(chunks.join('')));
        readableStream.on('error', reject);
    });
}

// Obtener datos
app.get('/api/ssl-data', async (req, res) => {
    try {
        if (!blockBlobClient) {
            return res.json(defaultData);
        }
        const downloadBlockBlobResponse = await blockBlobClient.download(0);
        const downloaded = await streamToString(downloadBlockBlobResponse.readableStreamBody);
        res.json(JSON.parse(downloaded));
    } catch (error) {
        if (error.statusCode === 404) {
            res.json(defaultData);
        } else {
            console.error('Error al leer de Blob:', error);
            res.status(500).json({ error: 'Error al leer los datos' });
        }
    }
});

// Guardar datos
app.post('/api/ssl-data', async (req, res) => {
    try {
        if (!blockBlobClient) {
            return res.status(500).json({ success: false, message: 'Almacenamiento no configurado' });
        }
        // Validar estructura básica
        const dataToSave = {
            aplicaciones: Array.isArray(req.body.aplicaciones) ? req.body.aplicaciones : [],
            certificados: Array.isArray(req.body.certificados) ? req.body.certificados : []
        };
        
        const dataString = JSON.stringify(dataToSave, null, 2);
        await blockBlobClient.upload(dataString, dataString.length, {
            blobHTTPHeaders: { blobContentType: 'application/json' }
        });
        res.json({ success: true, message: 'Datos guardados en Azure Blob correctamente' });
    } catch (error) {
        console.error('Error al guardar en Blob:', error);
        res.status(500).json({ success: false, message: 'Error al guardar los datos' });
    }
});

// ===== HEALTH CHECK PARA AZURE =====
app.get('/api/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        blobConfigured: !!blockBlobClient 
    });
});

app.use((req, res) => {
    res.status(404).send('Not Found');
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});