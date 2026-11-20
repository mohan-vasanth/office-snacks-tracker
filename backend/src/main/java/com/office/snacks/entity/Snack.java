package com.office.snacks.entity;

import jakarta.persistence.*;
import java.time.Instant;
import java.math.BigDecimal;

@Entity @Table(name="snacks", uniqueConstraints=@UniqueConstraint(columnNames="name"))
public class Snack {
    @Id @GeneratedValue(strategy=GenerationType.IDENTITY) private Long id;
    @Column(nullable=false, length=120) private String name;
    @Column(name="unit_price", precision=10, scale=2) private BigDecimal unitPrice;
    @Column(nullable=false) private boolean active=true;
    @Column(name="created_at", nullable=false, updatable=false) private Instant createdAt=Instant.now();
    protected Snack() {}
    public Snack(String name, boolean active){this(name,active,null);}
    public Snack(String name, boolean active, BigDecimal unitPrice){this.name=name;this.active=active;this.unitPrice=unitPrice;}
    public Long getId(){return id;} public String getName(){return name;} public BigDecimal getUnitPrice(){return unitPrice;} public boolean isActive(){return active;} public Instant getCreatedAt(){return createdAt;}
    public void update(String name, boolean active){update(name,active,unitPrice);}
    public void update(String name, boolean active, BigDecimal unitPrice){this.name=name;this.active=active;this.unitPrice=unitPrice;}
}
