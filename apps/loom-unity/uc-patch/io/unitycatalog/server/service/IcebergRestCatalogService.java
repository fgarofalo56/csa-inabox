// CSA Loom overlay (#3339): this file is unitycatalog v0.5.0's own
// server/src/main/java/io/unitycatalog/server/service/IcebergRestCatalogService.java
// (sha256 9dcc3791ae86f77ef85b15d483b33bf320b6f10eb2165021150fb9fd963260b6, asserted at build)
// with ONLY the authorization of the read endpoints changed, backported from upstream
// unitycatalog commit da911fad3951 "[Server] Authorize the Iceberg REST catalog endpoints"
// (#1813). Upstream v0.5.0 (and v0.6.0, source read, not run) gates every Iceberg REST route on
// metastore OWNER, which the catalog permissions API cannot grant, so a principal holding real
// catalog grants was denied /v1/config. Every changed site is marked "#3339". Method bodies are
// untouched except listTables and listNamespaces, which now run the response filter their new
// @ResponseAuthorizeFilter requires, and fail closed when the per-request result filter is
// absent, matching upstream AuthorizedService.applyResponseFilter. listNamespaces also reads the
// schema repository directly, as #1813 does, instead of calling SchemaService.listSchemas
// in-process (that call failed with 500 "Authorization filter not initialized"). Drop this file
// when an upstream release that carries #1813 is adopted.
package io.unitycatalog.server.service;

import static io.unitycatalog.server.model.SecurableType.CATALOG;
import static io.unitycatalog.server.model.SecurableType.METASTORE;
import static io.unitycatalog.server.model.SecurableType.SCHEMA;
import static io.unitycatalog.server.model.SecurableType.TABLE;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.linecorp.armeria.common.HttpResponse;
import com.linecorp.armeria.common.HttpStatus;
import com.linecorp.armeria.server.annotation.ExceptionHandler;
import com.linecorp.armeria.server.annotation.Get;
import com.linecorp.armeria.server.annotation.Head;
import com.linecorp.armeria.server.annotation.Param;
import com.linecorp.armeria.server.annotation.Post;
import com.linecorp.armeria.server.ServiceRequestContext;
import com.linecorp.armeria.server.annotation.ProducesJson;
import io.unitycatalog.server.auth.AuthorizeExpressions;
import io.unitycatalog.server.auth.annotation.AuthorizeExpression;
import io.unitycatalog.server.auth.annotation.AuthorizeResourceKey;
import io.unitycatalog.server.auth.annotation.ResponseAuthorizeFilter;
import io.unitycatalog.server.auth.decorator.ResultFilter;
import io.unitycatalog.server.auth.decorator.UnityAccessDecorator;
import io.unitycatalog.server.exception.BaseException;
import io.unitycatalog.server.exception.ErrorCode;
import io.unitycatalog.server.exception.IcebergRestExceptionHandler;
import io.unitycatalog.server.model.ListSchemasResponse;
import io.unitycatalog.server.model.ListTablesResponse;
import io.unitycatalog.server.model.SchemaInfo;
import io.unitycatalog.server.model.SecurableType;
import io.unitycatalog.server.model.TableInfo;
import io.unitycatalog.server.persist.Repositories;
import io.unitycatalog.server.persist.SchemaRepository;
import io.unitycatalog.server.persist.TableRepository;
import io.unitycatalog.server.service.iceberg.MetadataService;
import io.unitycatalog.server.service.iceberg.TableConfigService;
import io.unitycatalog.server.utils.JsonUtils;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.stream.Collectors;
import org.apache.iceberg.TableMetadata;
import org.apache.iceberg.catalog.Namespace;
import org.apache.iceberg.catalog.TableIdentifier;
import org.apache.iceberg.exceptions.BadRequestException;
import org.apache.iceberg.exceptions.NoSuchTableException;
import org.apache.iceberg.exceptions.NoSuchViewException;
import org.apache.iceberg.rest.Endpoint;
import org.apache.iceberg.rest.responses.ConfigResponse;
import org.apache.iceberg.rest.responses.GetNamespaceResponse;
import org.apache.iceberg.rest.responses.ListNamespacesResponse;
import org.apache.iceberg.rest.responses.LoadTableResponse;
import org.apache.iceberg.rest.responses.LoadViewResponse;
import org.hibernate.Session;
import org.hibernate.SessionFactory;

@ExceptionHandler(IcebergRestExceptionHandler.class)
public class IcebergRestCatalogService {

  private static final String PREFIX_BASE = "catalogs/";

  private static final List<Endpoint> ENDPOINTS =
      List.of(
          Endpoint.V1_LIST_NAMESPACES,
          Endpoint.V1_LOAD_NAMESPACE,
          Endpoint.V1_TABLE_EXISTS,
          Endpoint.V1_LOAD_TABLE,
          Endpoint.V1_LOAD_VIEW,
          Endpoint.V1_REPORT_METRICS,
          Endpoint.V1_LIST_TABLES);

  // #3339: verbatim from upstream AuthorizeExpressions (da911fad3951, #1813). Inlined because
  // v0.5.0's AuthorizeExpressions has no GET_CATALOG / GET_SCHEMA; GET_TABLE below is v0.5.0's
  // own constant, which is the same policy #1813 applies to the Iceberg table reads.
  static final String GET_CATALOG =
      """
      #authorize(#principal, #metastore, OWNER) ||
      #authorizeAny(#principal, #catalog, OWNER, USE_CATALOG)
      """;

  static final String GET_SCHEMA =
      """
      #authorize(#principal, #metastore, OWNER) ||
      #authorize(#principal, #catalog, OWNER) ||
      (#authorizeAny(#principal, #catalog, USE_CATALOG) &&
          #authorizeAny(#principal, #schema, OWNER, USE_SCHEMA))
      """;

  private final SchemaService schemaService;
  private final TableConfigService tableConfigService;
  private final MetadataService metadataService;
  private final TableRepository tableRepository;
  private final SchemaRepository schemaRepository; // #3339: listNamespaces reads it directly
  private final SessionFactory sessionFactory;

  public IcebergRestCatalogService(
      SchemaService schemaService,
      TableConfigService tableConfigService,
      MetadataService metadataService,
      Repositories repositories) {
    this.schemaService = schemaService;
    this.tableConfigService = tableConfigService;
    this.metadataService = metadataService;
    this.tableRepository = repositories.getTableRepository();
    this.schemaRepository = repositories.getSchemaRepository(); // #3339
    this.sessionFactory = repositories.getSessionFactory();
  }

  // Config APIs

  @Get("/v1/config")
  @ProducesJson
  @AuthorizeExpression(GET_CATALOG) // #3339
  @AuthorizeResourceKey(METASTORE)
  public ConfigResponse config(
      @Param("warehouse") @AuthorizeResourceKey(CATALOG) Optional<String> catalogOpt) { // #3339
    String catalog =
        catalogOpt.orElseThrow(
            () -> new BadRequestException("Must supply a proper catalog in warehouse property."));

    // TODO: check catalog exists
    // set catalog prefix
    return ConfigResponse.builder()
        .withOverride("prefix", PREFIX_BASE + catalog)
        .withEndpoints(ENDPOINTS)
        .build();
  }

  // Namespace APIs

  @Get("/v1/catalogs/{catalog}/namespaces")
  @ProducesJson
  @AuthorizeExpression(GET_SCHEMA) // #3339
  @ResponseAuthorizeFilter // #3339
  @AuthorizeResourceKey(METASTORE)
  public ListNamespacesResponse listNamespaces(
      @Param("catalog") @AuthorizeResourceKey(CATALOG) String catalog, // #3339
      @Param("parent") Optional<String> parent) {
    // #3339: read the schemas from the repository, as upstream #1813 does, instead of calling
    // SchemaService.listSchemas in-process. That in-process call ran the SchemaService's own
    // response filter under THIS route's request context, which (before #3339) carried no filter,
    // so it failed with 500 "Authorization filter not initialized" for every caller that got past
    // the gate.
    List<SchemaInfo> schemas = new ArrayList<>();
    if (parent.isEmpty() || parent.get().isEmpty()) {
      // Follow the repository's page token to the end: this endpoint returns the whole listing.
      Optional<String> pageToken = Optional.empty();
      do {
        ListSchemasResponse resp =
            schemaRepository.listSchemas(catalog, Optional.empty(), pageToken);
        assert resp.getSchemas() != null;
        schemas.addAll(resp.getSchemas());
        String next = resp.getNextPageToken();
        pageToken = next == null || next.isEmpty() ? Optional.empty() : Optional.of(next);
      } while (pageToken.isPresent());
    }
    // else: nested namespaces are not supported, so child namespaces are empty (v0.5.0 behaviour,
    // kept; upstream #1813 additionally 404s an absent parent).

    // #3339: drop the schemas the caller cannot read, per schema, with the GET_SCHEMA policy
    // (upstream #1813: applyResponseFilter(SCHEMA, schemas)). Run on the empty list too, so the
    // decorator sees the filter was called.
    applyResponseFilter(SCHEMA, schemas);

    return ListNamespacesResponse.builder()
        .addAll(
            schemas.stream()
                .map(schemaInfo -> Namespace.of(schemaInfo.getName()))
                .collect(Collectors.toList()))
        .build();
  }

  @Get("/v1/catalogs/{catalog}/namespaces/{namespace}")
  @ProducesJson
  @AuthorizeExpression(GET_SCHEMA) // #3339
  @AuthorizeResourceKey(METASTORE)
  public GetNamespaceResponse getNamespace(
      @Param("catalog") @AuthorizeResourceKey(CATALOG) String catalog, // #3339
      @Param("namespace") @AuthorizeResourceKey(SCHEMA) String namespace) // #3339
      throws JsonProcessingException {
    String schemaFullName = String.join(".", catalog, namespace);
    String resp = schemaService.getSchema(schemaFullName).aggregate().join().contentUtf8();
    return GetNamespaceResponse.builder()
        .withNamespace(Namespace.of(namespace))
        .setProperties(JsonUtils.getInstance().readValue(resp, SchemaInfo.class).getProperties())
        .build();
  }

  // Table APIs

  @Head("/v1/catalogs/{catalog}/namespaces/{namespace}/tables/{table}")
  @AuthorizeExpression(AuthorizeExpressions.GET_TABLE) // #3339
  @AuthorizeResourceKey(METASTORE)
  public HttpResponse tableExists(
      @Param("catalog") @AuthorizeResourceKey(CATALOG) String catalog, // #3339
      @Param("namespace") @AuthorizeResourceKey(SCHEMA) String namespace, // #3339
      @Param("table") @AuthorizeResourceKey(TABLE) String table) { // #3339
    try (Session session = sessionFactory.openSession()) {
      tableRepository.getTable(catalog + "." + namespace + "." + table);
      String metadataLocation =
          tableRepository.getTableUniformMetadataLocation(session, catalog, namespace, table);
      if (metadataLocation == null) {
        throw new NoSuchTableException("Table does not exist: %s", namespace + "." + table);
      } else {
        return HttpResponse.of(HttpStatus.OK);
      }
    }
  }

  @Get("/v1/catalogs/{catalog}/namespaces/{namespace}/tables/{table}")
  @ProducesJson
  @AuthorizeExpression(AuthorizeExpressions.GET_TABLE) // #3339
  @AuthorizeResourceKey(METASTORE)
  public LoadTableResponse loadTable(
      @Param("catalog") @AuthorizeResourceKey(CATALOG) String catalog, // #3339
      @Param("namespace") @AuthorizeResourceKey(SCHEMA) String namespace, // #3339
      @Param("table") @AuthorizeResourceKey(TABLE) String table) { // #3339
    String metadataLocation;
    try (Session session = sessionFactory.openSession()) {
      tableRepository.getTable(catalog + "." + namespace + "." + table);
      metadataLocation =
          tableRepository.getTableUniformMetadataLocation(session, catalog, namespace, table);
    }

    if (metadataLocation == null) {
      throw new NoSuchTableException("Table does not exist: %s", namespace + "." + table);
    }

    TableMetadata tableMetadata = metadataService.readTableMetadata(metadataLocation);
    Map<String, String> config = tableConfigService.getTableConfig(tableMetadata);

    return LoadTableResponse.builder()
        .withTableMetadata(tableMetadata)
        .addAllConfig(config)
        .build();
  }

  @Get("/v1/catalogs/{catalog}/namespaces/{namespace}/views/{view}")
  @ProducesJson
  @AuthorizeExpression(AuthorizeExpressions.GET_TABLE) // #3339
  @AuthorizeResourceKey(METASTORE)
  public LoadViewResponse loadView(
      @Param("catalog") @AuthorizeResourceKey(CATALOG) String catalog, // #3339
      @Param("namespace") @AuthorizeResourceKey(SCHEMA) String namespace, // #3339
      @Param("view") @AuthorizeResourceKey(TABLE) String view) { // #3339
    // this is not supported yet, but Iceberg REST client tries to load
    // a table with given path name and then tries to load a view with that
    // name if it didn't find a table, so for now, let's just return a 404
    // as that should be expected since it didn't find a table with the name
    throw new NoSuchViewException("View does not exist: %s", namespace + "." + view);
  }

  @Post("/v1/catalogs/{catalog}/namespaces/{namespace}/tables/{table}/metrics")
  @AuthorizeExpression(AuthorizeExpressions.GET_TABLE) // #3339
  @AuthorizeResourceKey(METASTORE)
  public HttpResponse reportMetrics(
      @Param("catalog") @AuthorizeResourceKey(CATALOG) String catalog, // #3339
      @Param("namespace") @AuthorizeResourceKey(SCHEMA) String namespace, // #3339
      @Param("table") @AuthorizeResourceKey(TABLE) String table) { // #3339
    return HttpResponse.of(HttpStatus.OK);
  }

  @Get("/v1/catalogs/{catalog}/namespaces/{namespace}/tables")
  @ProducesJson
  @AuthorizeExpression(AuthorizeExpressions.GET_TABLE) // #3339
  @ResponseAuthorizeFilter // #3339
  @AuthorizeResourceKey(METASTORE)
  public org.apache.iceberg.rest.responses.ListTablesResponse listTables(
      @Param("catalog") @AuthorizeResourceKey(CATALOG) String catalog, // #3339
      @Param("namespace") @AuthorizeResourceKey(SCHEMA) String namespace) // #3339
      throws JsonProcessingException {
    ListTablesResponse tables =
        tableRepository.listTables(
            catalog, namespace, Optional.of(Integer.MAX_VALUE), Optional.empty(), false, false);
    List<TableInfo> icebergTables; // #3339: keep the TableInfo so the filter can read its id
    try (Session session = sessionFactory.openSession()) {
      icebergTables =
          Objects.requireNonNull(tables.getTables()).stream()
              .filter(
                  tableInfo -> {
                    String metadataLocation =
                        tableRepository.getTableUniformMetadataLocation(
                            session, catalog, namespace, tableInfo.getName());
                    return metadataLocation != null;
                  })
              .collect(Collectors.toCollection(ArrayList::new));
    }

    // #3339: drop the tables the caller cannot read, per table, with the same GET_TABLE policy as
    // loadTable (upstream #1813 does this through AuthorizedService.applyResponseFilter).
    applyResponseFilter(TABLE, icebergTables);

    List<TableIdentifier> filteredTables =
        icebergTables.stream()
            .map(
                tableInfo ->
                    TableIdentifier.of(
                        Namespace.of(tableInfo.getSchemaName()), tableInfo.getName()))
            .collect(Collectors.toList());

    return org.apache.iceberg.rest.responses.ListTablesResponse.builder()
        .addAll(filteredTables)
        .build();
  }

  // #3339: this v0.5.0 class does not extend AuthorizedService, so it carries upstream's
  // applyResponseFilter contract itself. With authorization enabled, UnityAccessDecorator sets the
  // per-request result filter for every @ResponseAuthorizeFilter route before the method runs; if
  // it is absent, fail closed with the same error code upstream raises (INTERNAL, a 500) rather
  // than return the list unfiltered. The message deliberately differs from upstream's text: the
  // Console falls back to the Unity schemas API on upstream's exact message, and that fallback
  // must not hide this failure. With authorization disabled there is no decorator and nothing to
  // filter. serverProperties is AuthorizedService's protected field, reachable from this package.
  private <T> void applyResponseFilter(SecurableType securableType, List<T> items) {
    if (!schemaService.serverProperties.isAuthorizationEnabled()) {
      return;
    }
    ResultFilter resultFilter =
        ServiceRequestContext.current().attr(UnityAccessDecorator.RESULT_FILTER_ATTR);
    if (resultFilter == null) {
      throw new BaseException(
          ErrorCode.INTERNAL,
          "Result filter not installed for this Iceberg list request while authorization is"
              + " enabled.");
    }
    resultFilter.filter(securableType, items);
  }
}
