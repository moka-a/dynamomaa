import { DynamoDB } from "aws-sdk"
import { WriteRequest } from "aws-sdk/clients/dynamodb"
import { ConstructType } from "relater"
import { DynamoCursor, DynamoNode, QueryOptions, QueryResult } from "../interfaces/connection"
import { createOptions } from "../repository/create-options"
import { Repository } from "../repository/repository"
import { fromDynamoAttributeMap } from "./from-dynamo-attribute"
import { toDynamoAttributeMap, toDynamoAttribute } from "./to-dynamo-attribute"
import { RepositoryOptions } from "../interfaces/repository"


export class Connection {

  public repositories = new Map<ConstructType<any>, Repository<any>>()

  public constructor(public client: DynamoDB) { }

  public getRepository<Entity, R extends Repository<Entity>>(ctor: ConstructType<Entity>): R {
    let repository = this.repositories.get(ctor)
    if (!repository) {
      repository = new Repository(this, createOptions(ctor))
      this.repositories.set(ctor, repository)
    }
    return repository as R
  }

  public putItems<P = any>(options: RepositoryOptions<P>, rows: DynamoNode<P>[] = []): Promise<boolean[]> {
    if (rows.length === 0) {
      return Promise.resolve([])
    }
    return new Promise((resolve, reject) => {
      let writeRequests: WriteRequest[]
      try {
        writeRequests = rows.map(({ cursor: { hash, range }, node }): WriteRequest => {
          return options.rangeKey 
            ? {
              PutRequest: {
                Item: {
                  [options.hashKey.sourceKey]: toDynamoAttribute(hash),
                  [options.rangeKey.sourceKey]: toDynamoAttribute(range),
                  ...toDynamoAttributeMap(node),
                },
              }
            }
            : {
              PutRequest: {
                Item: {
                  [options.hashKey.sourceKey]: toDynamoAttribute(hash),
                  ...toDynamoAttributeMap(node),
                },
              }
            }
        })
      } catch (e) {
        return reject(e)
      }

      this.client.batchWriteItem({
        RequestItems: {
          [`${options.tableName}`]: writeRequests,
        },
      }, (err, result) => {
        if (err) {
          return reject(err)
        }
        if (result.UnprocessedItems && result.UnprocessedItems[`${options.tableName}`]) {
          const failKeys = result.UnprocessedItems[`${options.tableName}`]
            .filter(({ DeleteRequest }) => DeleteRequest)
            .map(({ DeleteRequest }) => DeleteRequest!.Key)

          resolve(rows.map(({ cursor: { hash, range } }) => {
            const foundFailKey = failKeys.find((failKey) => failKey[options.hashKey.sourceKey].S === hash && (
              (!!options.rangeKey && (failKey[options.rangeKey.sourceKey].S === range)) ||
              (!!options.rangeKey && (failKey[options.rangeKey.sourceKey].N === range))
            ))
            return foundFailKey ? true : false
          }))
        }
        resolve(rows.map(() => true))
      }).promise()
    })
  }

  public putItem<P = any>(options: RepositoryOptions<P>, row: DynamoNode<P>): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.client.putItem({
        TableName: options.tableName,
        ReturnValues: "ALL_OLD",
        Item: options.rangeKey 
          ? {
            [options.hashKey.sourceKey]: toDynamoAttribute(row.cursor.hash),
            [options.rangeKey.sourceKey]: toDynamoAttribute(row.cursor.range),
            ...toDynamoAttributeMap(row.node),
          } 
          : {
            [options.hashKey.sourceKey]: toDynamoAttribute(row.cursor.hash),
            ...toDynamoAttributeMap(row.node),
          },
      }, (err) => {
        if (err) {
          return reject(err)
        }
        resolve(true)
      })
    })
  }

  public updateItem<P = any>(options: RepositoryOptions<P>, row: DynamoNode<P>): Promise<boolean> {
    const hashKey = options.hashKey.sourceKey
    const rangeKey = options.rangeKey ? options.rangeKey.sourceKey : undefined
    const keys = Object.keys(row.node).filter((key) => key != hashKey && key != rangeKey)
    
    return new Promise((resolve, reject) => {
      this.client.updateItem({
        TableName: options.tableName,
        Key: rangeKey
          ? {
            [`${hashKey}`]: toDynamoAttribute(row.cursor.hash),
            [`${rangeKey}`]: toDynamoAttribute(row.cursor.range)
          }
          : {
            [`${hashKey}`]: toDynamoAttribute(row.cursor.hash)
          },
        UpdateExpression: `SET ${keys.map(key => `#${key} = :${key}`).join(', ')}`,
        ExpressionAttributeNames: keys.reduce((carry, key) => {
          carry[`#${key}`] = key
          return carry
        }, {} as any),
        ExpressionAttributeValues: keys.reduce((carry, key) => {
          carry[`:${key}`] = toDynamoAttribute((row.node as any)[key])
          return carry
        }, {} as any),
      }, (err) => {
        if (err) {
          return reject(err)
        }
        resolve(true)
      })
    })
  }

  public getItem<P = any>(options: RepositoryOptions<P>, cursor: DynamoCursor): Promise<any | null> {
    return new Promise((resolve, reject) => this.client.getItem({
      TableName: `${options.tableName}`,
      Key: options.rangeKey 
        ? {
          [options.hashKey.sourceKey]: toDynamoAttribute(cursor.hash),
          [options.rangeKey.sourceKey]: toDynamoAttribute(cursor.range),
        } 
        : {
          [options.hashKey.sourceKey]: toDynamoAttribute(cursor.hash),
        },
    }, (err, data) => {
      if (err) {
        return reject(err)
      }
      if (data && data.Item) {
        resolve(fromDynamoAttributeMap(data.Item))
      }
      resolve(null)
    }))
  }

  public getManyItems<P = any>(options: RepositoryOptions<P>, cursors: DynamoCursor[]): Promise<any[]> {
    if (cursors.length === 0) {
      return Promise.resolve([])
    }
    return new Promise((resolve, reject) => this.client.batchGetItem({
      RequestItems: {
        [`${options.tableName}`]: {
          Keys: cursors.map((cursor) => (options.rangeKey 
            ? {
              [options.hashKey.sourceKey]: toDynamoAttribute(cursor.hash),
              [options.rangeKey.sourceKey]: toDynamoAttribute(cursor.range),
            } 
            : {
              [options.hashKey.sourceKey]: toDynamoAttribute(cursor.hash),
            })),
        },
      }
    }, (err, result) => {
      if (err) {
        return reject(err)
      }
      if (result && result.Responses && result.Responses[`${options.tableName}`]) {
        return resolve(result.Responses[`${options.tableName}`].map(fromDynamoAttributeMap))
      }
      resolve([])
    }))
  }

  public query<P = any>(options: RepositoryOptions<P>, { indexName, hash, range, limit = 20, after, desc = false }: QueryOptions<P> = { hash: "all" }): Promise<QueryResult<P>> {
    const hashKey = indexName
      ? (() => {
        const indexHash = options.indexes.find(({ name }) => name == indexName)!.hashKey
        if (indexHash.generated) {
          return indexHash.generated.key!
        }
        else {
          return indexHash.sourceKey!
        }
      })()
      : options.hashKey.sourceKey
    let isGeneratedRangeKey = false
    const rangeKey = indexName 
      ? (() => {
        const indexRange = options.indexes.find(({ name }) => name == indexName)!.rangeKey
        if (!indexRange) {
          return undefined
        }

        if (indexRange.generated) {
          isGeneratedRangeKey = true
          return indexRange.generated.key
        }
        else {
          return indexRange.sourceKey
        }
      })() 
      : options.rangeKey ? options.rangeKey.sourceKey : undefined

    return new Promise((resolve, reject) => this.client.query({
      TableName: `${options.tableName}`,
      IndexName: indexName ? indexName : undefined,
      Limit: limit,
      KeyConditionExpression: range 
        ? `#hashkey = :hashkey and begins_with(#rangekey, :rangekey)` 
        : `#hashkey = :hashkey`,
      ExpressionAttributeNames: range 
        ? {
          "#hashkey": hashKey,
          "#rangekey": rangeKey!
        } 
        : {
          "#hashkey": hashKey
        },
      ExpressionAttributeValues: range 
        ? {
          ":hashkey": typeof hash == "string" ? { S: hash } : { N: `${hash}` },
          ":rangekey": isGeneratedRangeKey ? { S: `${range}__` } : { S: `${range}` }
        } 
        : {
          ":hashkey": typeof hash == "string" ? { S: hash } : { N: `${hash}` }
        },
      ExclusiveStartKey: after 
        ? after
        : undefined,
      ScanIndexForward: !desc,
    }, (err, result) => {
      if (err) {
        return reject(err)
      }
      const nodes: P[] = (result.Items || []).map((item) => {
        return fromDynamoAttributeMap(item) as P
      })
      if (result.LastEvaluatedKey) {
        return resolve({
          nodes,
          endCursor: result.LastEvaluatedKey,
        })
      }
      resolve({
        nodes,
      })
    }))
  }

  public count<P = any>(options: RepositoryOptions<P>, indexName?: string, hash: string | number = ""): Promise<number> {
    const hashKey = indexName
      ? (() => {
        const indexHash = options.indexes.find(({ name }) => name == indexName)!.hashKey
        if (indexHash.generated) {
          return indexHash.generated.key!
        }
        else {
          return indexHash.sourceKey!
        }
      })()
      : options.hashKey.sourceKey

    return new Promise((resolve, reject) => {
      this.client.query({
        TableName: `${options.tableName}`,
        IndexName: indexName ? indexName : undefined,
        Select: "COUNT",
        KeyConditionExpression: `#hashkey = :hashkey`,
        ExpressionAttributeNames: {
          "#hashkey": hashKey,
        },
        ExpressionAttributeValues: {
          ":hashkey": toDynamoAttribute(hash),
        },
      }, (err, result) => {
        if (err) {
          return reject(err)
        }
        resolve(result.Count || 0)
      })
    })
  }

  public deleteItem<P = any>(options: RepositoryOptions<P>, hashKey: string, rangeKey?: string): Promise<boolean> {
    return new Promise((resolve, reject) => this.client.deleteItem({
      TableName: `${options.tableName}`,
      Key: options.rangeKey 
        ? {
          [options.hashKey.sourceKey]: toDynamoAttribute(hashKey),
          [options.rangeKey.sourceKey]: toDynamoAttribute(rangeKey),
        } 
        : {
          [options.hashKey.sourceKey]: toDynamoAttribute(hashKey),
        },
    }, (err) => {
      if (err) {
        return reject(err)
      }
      resolve(true)
    }))
  }

  public deleteManyItems<P = any>(options: RepositoryOptions<P>, cursors: DynamoCursor[]): Promise<boolean[]> {
    if (cursors.length === 0) {
      return Promise.resolve([])
    }
    return new Promise(((resolve, reject) => {
      this.client.batchWriteItem({
        RequestItems: {
          [`${options.tableName}`]: cursors.map(({ hash, range }): WriteRequest => {
            return {
              DeleteRequest: {
                Key: options.rangeKey 
                  ? {
                    [options.hashKey.sourceKey]: toDynamoAttribute(hash),
                    [options.rangeKey.sourceKey]: toDynamoAttribute(range),
                  }
                  : {
                    [options.hashKey.sourceKey]: toDynamoAttribute(hash),
                  },
              }
            }
          }),
        },
      }, (err, result) => {
        if (err) {
          return reject(err)
        }
        if (result.UnprocessedItems && result.UnprocessedItems[`${options.tableName}`]) {
          const failKeys = result.UnprocessedItems[`${options.tableName}`]
            .filter(({DeleteRequest}) => DeleteRequest)
            .map(({DeleteRequest}) => DeleteRequest!.Key)
          resolve(cursors.map((cursor) => {
            const foundFailKey = failKeys.find((failKey) => failKey[options.hashKey.sourceKey].S === cursor.hash && (
              (!!options.rangeKey && (failKey[options.rangeKey.sourceKey].S === cursor.range)) || 
              (!!options.rangeKey && (failKey[options.rangeKey.sourceKey].N === cursor.range))
            ))
            return foundFailKey ? true : false
          }))
        }
        resolve(cursors.map(() => true))
      }).promise()
    }))
  }

}
