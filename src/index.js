import express from 'express';
import cors from 'cors';
import amqp from 'amqplib';
import swaggerUi from 'swagger-ui-express';
import swaggerJsDoc from 'swagger-jsdoc';
import AWS from 'aws-sdk';

// AWS region and Lambda function configuration
const region = "us-east-2";
const lambdaFunctionName = "fetchSecretsFunction_gr8";

// Function to invoke Lambda and fetch secrets
async function getSecretFromLambda() {
  const lambda = new AWS.Lambda({ region: region });
  const params = {
    FunctionName: lambdaFunctionName,
  };

  try {
    const response = await lambda.invoke(params).promise();
    const payload = JSON.parse(response.Payload);
    if (payload.errorMessage) {
      throw new Error(payload.errorMessage);
    }
    const body = JSON.parse(payload.body);
    return JSON.parse(body.secret);
  } catch (error) {
    console.error('Error invoking Lambda function:', error);
    throw error;
  }
}

// Function to start the service
async function startService() {
  let secrets;
  try {
    secrets = await getSecretFromLambda();
  } catch (error) {
    console.error(`Error starting service: ${error}`);
    return;
  }

  AWS.config.update({
    region: region,
    accessKeyId: secrets.AWS_ACCESS_KEY_ID,
    secretAccessKey: secrets.AWS_SECRET_ACCESS_KEY,
  });

  const dynamoDB = new AWS.DynamoDB.DocumentClient();
  const app = express();
  const port = 8093;

  app.use(cors());
  app.use(express.json());

  // Swagger setup
  const swaggerOptions = {
    swaggerDefinition: {
      openapi: '3.0.0',
      info: {
        title: 'Delete Product Service API',
        version: '1.0.0',
        description: 'API for deleting products'
      }
    },
    apis: ['./src/index.js']
  };

  const swaggerDocs = swaggerJsDoc(swaggerOptions);
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

  // RabbitMQ setup
  let channel;
  async function connectRabbitMQ() {
    try {
      const connection = await amqp.connect('amqp://3.136.72.14:5672/');
      channel = await connection.createChannel();
      await channel.assertQueue('product-events', { durable: true });
      console.log('Connected to RabbitMQ');
    } catch (error) {
      console.error('Error connecting to RabbitMQ:', error);
    }
  }

  // Publish event to RabbitMQ
  const publishEvent = async (eventType, data) => {
    const event = { eventType, data };
    try {
      if (channel) {
        channel.sendToQueue('product-events', Buffer.from(JSON.stringify(event)), { persistent: true });
        console.log('Event published to RabbitMQ:', event);
      } else {
        console.error('Channel is not initialized');
      }
    } catch (error) {
      console.error('Error publishing event to RabbitMQ:', error);
    }
  };

  await connectRabbitMQ();

  /**
   * @swagger
   * /products/{productId}:
   *   delete:
   *     summary: Delete a product
   *     description: Delete a product by productId
   *     parameters:
   *       - in: path
   *         name: productId
   *         required: true
   *         description: ID of the product to delete
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Product deleted
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   example: "Product deleted"
   *       500:
   *         description: Error deleting product
   */
  app.delete('/products/:productId', async (req, res) => {
    const { productId } = req.params;
    const tables = ['Products_gr8', 'ProductsUpdate_gr8', 'ProductsList_gr8', 'ProductsDelete_gr8'];

    try {
      for (const table of tables) {
        const params = {
          TableName: table,
          Key: { productId }
        };
        await dynamoDB.delete(params).promise();
        console.log(`Product deleted from table: ${table}`);
      }

      // Publish product deleted event to RabbitMQ
      publishEvent('ProductDeleted', { productId });

      res.send({ message: 'Product deleted' });
    } catch (error) {
      console.error('Error deleting product:', error);
      res.status(500).send({ message: 'Error deleting product', error });
    }
  });

  app.get('/', (req, res) => {
    res.send('Delete Product Service Running');
  });

  app.listen(port, () => {
    console.log(`Delete Product service listening at http://localhost:${port}`);
  });
}

startService();
