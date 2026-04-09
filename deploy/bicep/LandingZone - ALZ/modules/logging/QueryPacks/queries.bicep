param parParent string
param parQueryPackQueries array
param tags object

resource queryPackDeployed 'Microsoft.OperationalInsights/queryPacks@2019-09-01' existing = {
  name: parParent
}

resource resQueryPackQueries 'Microsoft.OperationalInsights/queryPacks/queries@2019-09-01' = [for query in parQueryPackQueries: if (query.queryPackName == parParent) {
  name: guid('${query.displayName}')
  parent: queryPackDeployed
  properties: {
    body: query.bodyKQL
    description: query.description
    displayName: query.displayName
    related: {
      categories: query.Categories
      resourceTypes: query.Topic
      solutions: query.Solutions
    }
    tags: tags
  }
  }]
