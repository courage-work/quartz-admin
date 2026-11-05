package quartzadmin.testbed;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.io.IOException;
import java.io.StringReader;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.Properties;
import org.quartz.utils.ConnectionProvider;

/**
 * Quartz 2.3.2와 2.5.x에서 똑같이 동작하도록 HikariCP를 직접 붙이는 ConnectionProvider.
 *
 * <p>Quartz는 {@code org.quartz.dataSource.NAME.*} 속성을 setter로 넣은 뒤 {@link #initialize()}를 호출한다.
 */
public class HikariConnectionProvider implements ConnectionProvider {

  private String jdbcUrl;
  private String user;
  private String password;
  private int maxConnections = 8;
  private Properties driverProperties = new Properties();
  private HikariDataSource dataSource;

  public void setJdbcUrl(String jdbcUrl) {
    this.jdbcUrl = jdbcUrl;
  }

  public void setUser(String user) {
    this.user = user;
  }

  public void setPassword(String password) {
    this.password = password;
  }

  public void setMaxConnections(int maxConnections) {
    this.maxConnections = maxConnections;
  }

  /** properties 형식 텍스트({@code key=value} 줄 단위) */
  public void setDriverProperties(String text) throws IOException {
    Properties p = new Properties();
    p.load(new StringReader(text));
    this.driverProperties = p;
  }

  @Override
  public void initialize() throws SQLException {
    dataSource = create(jdbcUrl, user, password, driverProperties, maxConnections, "quartz");
  }

  @Override
  public Connection getConnection() throws SQLException {
    return dataSource.getConnection();
  }

  @Override
  public void shutdown() throws SQLException {
    if (dataSource != null) {
      dataSource.close();
    }
  }

  static HikariDataSource create(
      String jdbcUrl,
      String user,
      String password,
      Properties driverProperties,
      int maxConnections,
      String poolName) {
    HikariConfig cfg = new HikariConfig();
    cfg.setDataSourceProperties(driverProperties);
    cfg.setJdbcUrl(jdbcUrl);
    cfg.setUsername(user);
    cfg.setPassword(password);
    cfg.setMaximumPoolSize(maxConnections);
    cfg.setMinimumIdle(1);
    cfg.setPoolName(poolName);
    // Quartz는 트랜잭션을 직접 관리한다
    cfg.setAutoCommit(false);
    cfg.setConnectionTimeout(30_000);
    return new HikariDataSource(cfg);
  }
}
