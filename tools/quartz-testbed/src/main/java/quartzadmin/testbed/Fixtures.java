package quartzadmin.testbed;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.sql.Blob;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.quartz.utils.DBConnectionManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 차등 테스트용 도구(TRD §12.1, 부록 A.1). Quartz API로 만들 수 없는 초기 상태를 SQL로 만들고, 잠금 행을 일부러 붙잡고, 결과 행을
 * 비교 가능한 JSON으로 내보낸다. Quartz와 같은 커넥션 풀(데이터 소스 {@value TestbedConfig#DATA_SOURCE})을 쓴다.
 *
 * <p>SQL은 JDBC 표준 문법만 써서 DB 4종에서 같은 코드가 돈다.
 */
public final class Fixtures {

  private static final Logger log = LoggerFactory.getLogger(Fixtures.class);
  private static final JsonNodeFactory F = JsonNodeFactory.instance;

  /** 행 스냅샷에 넣는 테이블. JOB_DETAILS는 키와 IS_DURABLE만 본다(JOB_DATA는 직렬화 형식이 노드마다 다를 수 있음) */
  private static final List<String> SNAPSHOT_TABLES =
      List.of(
          "TRIGGERS",
          "SIMPLE_TRIGGERS",
          "CRON_TRIGGERS",
          "SIMPROP_TRIGGERS",
          "BLOB_TRIGGERS",
          "PAUSED_TRIGGER_GRPS",
          "FIRED_TRIGGERS");

  private final String schedulerName;
  private final String tablePrefix;

  public Fixtures(String schedulerName, String tablePrefix) {
    // SQL에 그대로 붙이므로 식별자 문자만 받는다. 빈 prefix도 허용한다
    if (!tablePrefix.matches("[A-Za-z0-9_$#]{0,64}")) {
      throw new IllegalArgumentException("테이블 prefix로 쓸 수 없는 값입니다: " + tablePrefix);
    }
    this.schedulerName = schedulerName;
    this.tablePrefix = tablePrefix;
  }

  private static Connection connection() throws SQLException {
    return DBConnectionManager.getInstance().getConnection(TestbedConfig.DATA_SOURCE);
  }

  private String table(String name) {
    return tablePrefix + name;
  }

  private String sched(String requested) {
    return requested == null || requested.isEmpty() ? schedulerName : requested;
  }

  /** 문장들을 한 트랜잭션으로 실행한다. 하나라도 실패하면 모두 되돌린다. 결과는 문장별 바뀐 행 수 */
  public List<Integer> sql(List<String> statements) throws SQLException {
    List<Integer> counts = new ArrayList<>();
    try (Connection c = connection()) {
      c.setAutoCommit(false);
      try (Statement s = c.createStatement()) {
        for (String sql : statements) {
          counts.add(s.executeUpdate(sql));
        }
        c.commit();
      } catch (SQLException e) {
        c.rollback();
        throw e;
      }
    }
    return counts;
  }

  /**
   * Quartz 잠금 행을 {@code seconds}초 동안 잡는다({@code StdRowLockSemaphore}와 같은 SQL). 잡으면 바로 돌아오고, 시간이 지나면
   * ROLLBACK해 놓는다. 행이 없으면 넣고 잡는다(그 행도 ROLLBACK으로 사라진다).
   */
  public long holdLock(String schedName, String lockName, long seconds) throws Exception {
    String sched = sched(schedName);
    String lock = lockName == null || lockName.isEmpty() ? "TRIGGER_ACCESS" : lockName;
    CountDownLatch acquired = new CountDownLatch(1);
    AtomicReference<Throwable> failure = new AtomicReference<>();
    Thread holder =
        new Thread(
            () -> {
              try (Connection c = connection()) {
                c.setAutoCommit(false);
                try {
                  lockRow(c, sched, lock);
                  acquired.countDown();
                  log.info("{} 잠금을 {}초 동안 잡습니다 ({})", lock, seconds, sched);
                  Thread.sleep(TimeUnit.SECONDS.toMillis(seconds));
                } finally {
                  c.rollback();
                  log.info("{} 잠금을 놓았습니다 ({})", lock, sched);
                }
              } catch (Throwable e) {
                failure.compareAndSet(null, e);
                acquired.countDown();
              }
            },
            "testbed-hold-lock");
    holder.setDaemon(true);
    long started = System.currentTimeMillis();
    holder.start();
    if (!acquired.await(30, TimeUnit.SECONDS)) {
      throw new IllegalStateException("30초 안에 잠금을 잡지 못했습니다");
    }
    if (failure.get() != null) {
      throw new IllegalStateException("잠금을 잡지 못했습니다: " + failure.get().getMessage());
    }
    return System.currentTimeMillis() - started;
  }

  private void lockRow(Connection c, String sched, String lock) throws SQLException {
    try (PreparedStatement ps =
        c.prepareStatement(
            "SELECT * FROM "
                + table("LOCKS")
                + " WHERE SCHED_NAME = ? AND LOCK_NAME = ? FOR UPDATE")) {
      ps.setString(1, sched);
      ps.setString(2, lock);
      try (ResultSet rs = ps.executeQuery()) {
        if (rs.next()) {
          return;
        }
      }
    }
    try (PreparedStatement ps =
        c.prepareStatement("INSERT INTO " + table("LOCKS") + " (SCHED_NAME, LOCK_NAME) VALUES (?, ?)")) {
      ps.setString(1, sched);
      ps.setString(2, lock);
      ps.executeUpdate();
    }
  }

  /**
   * SCHED_NAME 하나의 Quartz 행을 테이블별로 내보낸다. SCHED_NAME 컬럼은 빼서 이름이 다른 두 스케줄러를 바로 비교할 수 있게 하고, 행은
   * JSON 문자열 순으로 정렬한다. 컬럼 이름은 대문자, 숫자는 정수면 정수로, BLOB은 base64로 바꾼다.
   */
  public ObjectNode snapshot(String schedName) throws SQLException {
    String sched = sched(schedName);
    ObjectNode out = F.objectNode();
    try (Connection c = connection()) {
      c.setAutoCommit(true);
      for (String t : SNAPSHOT_TABLES) {
        out.set(t, rows(c, "SELECT * FROM " + table(t) + " WHERE SCHED_NAME = ?", sched));
      }
      out.set(
          "JOB_DETAILS",
          rows(
              c,
              "SELECT JOB_NAME, JOB_GROUP, IS_DURABLE FROM " + table("JOB_DETAILS") + " WHERE SCHED_NAME = ?",
              sched));
      out.set(
          "LOCKS",
          rows(c, "SELECT LOCK_NAME FROM " + table("LOCKS") + " WHERE SCHED_NAME = ?", sched));
    }
    return out;
  }

  private static ArrayNode rows(Connection c, String sql, String sched) throws SQLException {
    List<ObjectNode> rows = new ArrayList<>();
    try (PreparedStatement ps = c.prepareStatement(sql)) {
      ps.setString(1, sched);
      try (ResultSet rs = ps.executeQuery()) {
        ResultSetMetaData md = rs.getMetaData();
        while (rs.next()) {
          ObjectNode row = F.objectNode();
          List<String> names = new ArrayList<>();
          for (int i = 1; i <= md.getColumnCount(); i++) {
            names.add(md.getColumnLabel(i).toUpperCase(Locale.ROOT));
          }
          // 컬럼 순서가 DB마다 달라도 같은 JSON이 되게 이름순으로 넣는다
          List<Integer> order = new ArrayList<>();
          for (int i = 1; i <= names.size(); i++) {
            order.add(i);
          }
          order.sort(Comparator.comparing(i -> names.get(i - 1)));
          for (int i : order) {
            String name = names.get(i - 1);
            if (!name.equals("SCHED_NAME")) {
              row.set(name, value(rs.getObject(i)));
            }
          }
          rows.add(row);
        }
      }
    }
    rows.sort(Comparator.comparing(ObjectNode::toString));
    ArrayNode arr = F.arrayNode();
    rows.forEach(arr::add);
    return arr;
  }

  private static com.fasterxml.jackson.databind.JsonNode value(Object v) throws SQLException {
    if (v == null) {
      return F.nullNode();
    }
    if (v instanceof BigDecimal d) {
      BigDecimal s = d.stripTrailingZeros();
      return s.scale() <= 0 ? F.numberNode(s.longValueExact()) : F.numberNode(d.doubleValue());
    }
    if (v instanceof Number n) {
      return n instanceof Double || n instanceof Float
          ? F.numberNode(n.doubleValue())
          : F.numberNode(n.longValue());
    }
    if (v instanceof Boolean b) {
      return F.booleanNode(b);
    }
    if (v instanceof byte[] bytes) {
      return F.textNode(Base64.getEncoder().encodeToString(bytes));
    }
    if (v instanceof Blob blob) {
      return F.textNode(Base64.getEncoder().encodeToString(blob.getBytes(1, (int) blob.length())));
    }
    return F.textNode(v.toString());
  }
}
