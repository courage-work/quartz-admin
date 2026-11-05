package quartzadmin.testbed;

import java.io.IOException;
import java.io.StringReader;
import java.util.Map;
import java.util.Properties;

/**
 * 환경변수로 받은 테스트베드 설정. Quartz 설정({@link #toQuartzProperties()})과 실행 기록용 DB 접속 정보를 만든다.
 */
public final class TestbedConfig {

  public static final String DATA_SOURCE = "testbed";

  final String jdbcUrl;
  final String dbUser;
  final String dbPassword;
  final String schedulerName;
  final String instanceId;
  final String tablePrefix;
  final String driverDelegate;
  final int threadCount;
  final long clusterCheckinIntervalMs;
  final long misfireThresholdMs;
  final int maxConnections;
  final int httpPort;
  final String executionsTable;
  final String extraQuartzProperties;
  final Properties driverProperties;

  private TestbedConfig(Map<String, String> env) {
    this.jdbcUrl = required(env, "TESTBED_DB_URL");
    this.dbUser = required(env, "TESTBED_DB_USER");
    this.dbPassword = required(env, "TESTBED_DB_PASSWORD");
    this.schedulerName = env.getOrDefault("TESTBED_SCHEDULER_NAME", "TestbedScheduler");
    this.instanceId = env.getOrDefault("TESTBED_INSTANCE_ID", "AUTO");
    this.tablePrefix = env.getOrDefault("TESTBED_TABLE_PREFIX", "QRTZ_");
    this.driverDelegate =
        env.getOrDefault("TESTBED_DRIVER_DELEGATE", defaultDelegate(this.jdbcUrl));
    this.threadCount = intValue(env, "TESTBED_THREAD_COUNT", 5);
    this.clusterCheckinIntervalMs = longValue(env, "TESTBED_CLUSTER_CHECKIN_INTERVAL_MS", 7500);
    this.misfireThresholdMs = longValue(env, "TESTBED_MISFIRE_THRESHOLD_MS", 60000);
    // Quartz 권장값: 스레드 수 + 3 (클러스터 체크인, misfire 처리, 실행 기록)
    this.maxConnections = intValue(env, "TESTBED_MAX_CONNECTIONS", this.threadCount + 3);
    this.httpPort = intValue(env, "TESTBED_HTTP_PORT", 8080);
    this.executionsTable = identifier(env.getOrDefault("TESTBED_EXECUTIONS_TABLE", "TESTBED_EXECUTIONS"));
    this.extraQuartzProperties = env.getOrDefault("TESTBED_QUARTZ_PROPERTIES", "");
    this.driverProperties = driverProperties(this.jdbcUrl, env.getOrDefault("TESTBED_DB_PROPERTIES", ""));
  }

  /**
   * JDBC 드라이버 속성. Oracle은 {@code oracle.jdbc.sendBooleanAsNativeBoolean}의 기본값을 false로 둔다.
   *
   * <p>ojdbc 23은 Oracle 23에 접속하면 {@code setBoolean}을 네이티브 BOOLEAN으로 보내, Quartz 기본 스키마의 VARCHAR2(1)
   * 불리언 컬럼에 {@code 'true'}를 넣으려다 ORA-12899로 실패한다. false로 두면 이전 드라이버처럼 1/0을 보내므로 운영(19c 이하)과
   * 같은 {@code '1'/'0'} 값이 저장된다. {@code tables_oracle23.sql}(BOOLEAN 컬럼) 스키마에서는 true로 바꿔 쓴다.
   */
  static Properties driverProperties(String jdbcUrl, String text) {
    Properties p = new Properties();
    if (jdbcUrl.toLowerCase().startsWith("jdbc:oracle:")) {
      p.setProperty("oracle.jdbc.sendBooleanAsNativeBoolean", "false");
    }
    p.putAll(parseProperties(text, "TESTBED_DB_PROPERTIES"));
    return p;
  }

  private static Properties parseProperties(String text, String source) {
    Properties p = new Properties();
    if (text != null && !text.isBlank()) {
      try {
        p.load(new StringReader(text));
      } catch (IOException e) {
        throw new IllegalArgumentException(source + "를 읽지 못했습니다", e);
      }
    }
    return p;
  }

  /** Quartz가 setter로 넘길 수 있도록 드라이버 속성을 properties 텍스트로 만든다. */
  String driverPropertiesText() {
    StringBuilder b = new StringBuilder();
    driverProperties.stringPropertyNames().stream()
        .sorted()
        .forEach(k -> b.append(k).append('=').append(driverProperties.getProperty(k)).append('\n'));
    return b.toString();
  }

  public static TestbedConfig fromEnv(Map<String, String> env) {
    return new TestbedConfig(env);
  }

  /** JDBC URL로 DB 종류를 보고 Quartz delegate를 고른다. */
  static String defaultDelegate(String jdbcUrl) {
    String url = jdbcUrl.toLowerCase();
    if (url.startsWith("jdbc:oracle:")) {
      return "org.quartz.impl.jdbcjobstore.oracle.OracleDelegate";
    }
    if (url.startsWith("jdbc:postgresql:")) {
      return "org.quartz.impl.jdbcjobstore.PostgreSQLDelegate";
    }
    return "org.quartz.impl.jdbcjobstore.StdJDBCDelegate";
  }

  public Properties toQuartzProperties() {
    Properties p = new Properties();
    p.setProperty("org.quartz.scheduler.instanceName", schedulerName);
    p.setProperty("org.quartz.scheduler.instanceId", instanceId);
    p.setProperty("org.quartz.scheduler.skipUpdateCheck", "true");
    p.setProperty("org.quartz.threadPool.class", "org.quartz.simpl.SimpleThreadPool");
    p.setProperty("org.quartz.threadPool.threadCount", Integer.toString(threadCount));
    p.setProperty("org.quartz.jobStore.class", "org.quartz.impl.jdbcjobstore.JobStoreTX");
    p.setProperty("org.quartz.jobStore.driverDelegateClass", driverDelegate);
    p.setProperty("org.quartz.jobStore.dataSource", DATA_SOURCE);
    p.setProperty("org.quartz.jobStore.tablePrefix", tablePrefix);
    p.setProperty("org.quartz.jobStore.isClustered", "true");
    p.setProperty(
        "org.quartz.jobStore.clusterCheckinInterval", Long.toString(clusterCheckinIntervalMs));
    p.setProperty("org.quartz.jobStore.misfireThreshold", Long.toString(misfireThresholdMs));
    p.setProperty("org.quartz.jobStore.useProperties", "false");

    String ds = "org.quartz.dataSource." + DATA_SOURCE + ".";
    p.setProperty(ds + "connectionProvider.class", HikariConnectionProvider.class.getName());
    p.setProperty(ds + "jdbcUrl", jdbcUrl);
    p.setProperty(ds + "user", dbUser);
    p.setProperty(ds + "password", dbPassword);
    p.setProperty(ds + "maxConnections", Integer.toString(maxConnections));
    p.setProperty(ds + "driverProperties", driverPropertiesText());

    p.putAll(parseProperties(extraQuartzProperties, "TESTBED_QUARTZ_PROPERTIES"));
    return p;
  }

  private static String required(Map<String, String> env, String key) {
    String v = env.get(key);
    if (v == null || v.isBlank()) {
      throw new IllegalArgumentException("환경변수 " + key + "가 필요합니다");
    }
    return v;
  }

  private static int intValue(Map<String, String> env, String key, int fallback) {
    String v = env.get(key);
    return v == null || v.isBlank() ? fallback : Integer.parseInt(v.trim());
  }

  private static long longValue(Map<String, String> env, String key, long fallback) {
    String v = env.get(key);
    return v == null || v.isBlank() ? fallback : Long.parseLong(v.trim());
  }

  /** SQL에 그대로 들어가는 이름이므로 단순 식별자만 허용한다. */
  static String identifier(String name) {
    if (!name.matches("[A-Za-z][A-Za-z0-9_$#]{0,127}")) {
      throw new IllegalArgumentException("식별자로 쓸 수 없는 이름입니다: " + name);
    }
    return name;
  }
}
